/**
 * El camino que de verdad rescata a la familia, ejercitado de punta a punta.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO. Durante una ronda entera la «restauración
 * probada» cubría sólo el ensayo en PGlite. `--destino supabase` —el único
 * comando que devuelve la base cuando pasa lo peor— NUNCA ejecutó una sola
 * escritura en ninguna parte, y es un camino DISTINTO del ensayo: reenlaza las
 * cuentas por correo, filtra otras llaves foráneas y NO restaura `auth.users`.
 * Un respaldo cuya restauración real nadie probó no es un respaldo: es un
 * archivo.
 *
 * QUÉ SE PRUEBA ACÁ. No se puede —ni se debe— escribir en la base de la familia
 * para probar esto. Lo que sí se puede es correr EL MISMO MOTOR
 * (`scripts/respaldo-nucleo.mjs`, en `modo: "real"`, `seco: false`) contra un
 * Postgres desechable que sí se deja borrar. Eso cubre todo el código de la
 * restauración real: el reenlace de cuentas, el plan de carga, el borrado, el
 * insert, la relectura, los hashes y los huérfanos.
 *
 * LO QUE NO CUBRE, dicho fuerte para que nadie se confíe:
 *   - Que el rol de la Management API tenga permiso para
 *     `set session_replication_role`. PGlite corre como superusuario: acá da
 *     verde POR CONSTRUCCIÓN. Por eso el motor lo PREGUNTA antes de borrar nada
 *     y por eso hay abajo una prueba de que se planta cuando la respuesta es no.
 *   - Que la base viva aguante la escritura: cuota, tamaño de la respuesta HTTP,
 *     tiempos de la Management API.
 * Eso lo ensaya `respaldo-restaurar.mjs --destino supabase --en-seco`, que sí
 * le habla a producción pero no le escribe una fila.
 */

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRACIONES } from "./harness";

// ---------------------------------------------------------------------------
// Los scripts son .mjs y viven fuera de web/: se cargan por URL en tiempo de
// ejecución. Las formas que se usan se declaran acá para no perder el tipado.
// ---------------------------------------------------------------------------

type Fila = Record<string, unknown>;

interface Ejecutor {
  nombre: string;
  ejecutar(sql: string): Promise<Fila[]>;
  escribir(sql: string): Promise<Fila[]>;
}

interface Migracion {
  archivo: string;
  sha256: string;
  sql: string;
}

interface BaseDesechable {
  db: { exec(sql: string): Promise<unknown>; close(): Promise<void> };
  aplicadas: Migracion[];
  todas: Migracion[];
  sobrantes: string[];
  nivel: string | null;
  fuente: string;
  calces: string[];
  notas: string[];
}

interface Columna {
  nombre: string;
  tipo: string;
  derivada?: boolean;
  identidad?: boolean;
  obligatoria?: boolean;
  con_default?: boolean;
}

interface TablaDeclarada {
  nombre: string;
  esquema?: string;
  pk: string[];
  columnas: Columna[];
}

interface BloqueDeTabla {
  tipo: "tabla";
  nombre: string;
  esquema: string;
  filas: number;
  sha256: string;
  datos: Fila[];
}

interface Cabecera {
  esquema: { tablas: TablaDeclarada[]; fks: unknown[] };
  migraciones: { archivo: string; sha256: string }[];
  proyecto_ref: string;
  [clave: string]: unknown;
}

interface Respaldo {
  cabecera: Cabecera;
  cierre: { filas: number; tablas: number; sha256_contenido: string };
  tablas: BloqueDeTabla[];
  ruta: string;
}

interface Resultado {
  ok: boolean;
  problemas: string[];
  avisos: string[];
  hallazgos: string[];
  plan: { tabla: string; filas: Fila[]; sql: string }[];
  seco: boolean;
  conDatos: [string, number][];
  cuentasDestino: { id: string | null; email: string | null; created_at: string | null }[];
  huboReenlace?: boolean;
  tablasOk?: number;
  huerfanos?: number;
}

interface Lib {
  SQL_ESQUEMA: string;
  TABLA_AUTH_USERS: TablaDeclarada;
  armarArchivoDeRespaldo(entrada: Record<string, unknown>): { texto: string };
  baseConMigraciones(archivos: string[]): Promise<BaseDesechable>;
  canonizarFila(fila: Fila, columnas: Columna[]): string;
  diferenciasDeEsquema(
    destino: TablaDeclarada[],
    respaldo: TablaDeclarada[],
  ): { clase: string; tabla: string; columna?: string; detalle: string }[];
  ejecutorPglite(db: unknown, nombre?: string): Ejecutor;
  elegirNivelDelRespaldo(entrada: {
    todas: Migracion[];
    calces: string[];
    porLibro: string[] | null;
    calzaPorLibro: boolean;
    notasLibro: string[];
  }): { seleccion: string[]; fuente: string; calces: string[]; notas: string[] };
  expresionEscritura(columna: Columna, origen?: string): string;
  expresionLectura(columna: Columna, alias?: string): string;
  hashDeFilas(filas: Fila[], columnas: Columna[]): string;
  interpretarSonda(filas: Fila[]): { permitido: boolean; motivo: string | null; detalle: Fila | null };
  leerRespaldo(ruta: string): Respaldo;
  migracionesDelRepo(): Migracion[];
  motivoParaNoGuardarAca(destino: string): string | null;
  sqlFotoCompleta(tablas: TablaDeclarada[]): string;
}

interface Nucleo {
  ejecutorEnSeco(real: Ejecutor): Ejecutor & { sentencias: string[] };
  planDeCarga(entrada: {
    orden: string[];
    esquemaRespaldo: Map<string, TablaDeclarada>;
    porNombre: Map<string, BloqueDeTabla>;
    columnasDeUsuario: { tabla: string; columna: string }[];
    mapaUsuarios: Map<string, string> | null;
  }): { tabla: string; filas: Fila[]; sql: string }[];
  sqlCargarTabla(definicion: TablaDeclarada, filas: Fila[]): string;
  restaurar(entrada: Record<string, unknown>): Promise<Resultado>;
}

const RAIZ_SCRIPTS = path.resolve(__dirname, "../../../scripts");
const urlDe = (archivo: string) => pathToFileURL(path.join(RAIZ_SCRIPTS, archivo)).href;

let lib: Lib;
let nucleo: Nucleo;

// ---------------------------------------------------------------------------
// El hogar de mentira, con las dos tablas que llevan la identidad de la ficha
// ---------------------------------------------------------------------------

const ANA = "11111111-1111-4111-8111-111111111111";
const BETO = "22222222-2222-4222-8222-222222222222";
/** En el proyecto destino las cuentas se crean de nuevo: MISMO correo, OTRO id. */
const ANA_NUEVA = "aaaaaaaa-1111-4111-8111-111111111111";
const BETO_NUEVO = "bbbbbbbb-2222-4222-8222-222222222222";

const SEMBRAR_ORIGEN = `
  insert into auth.users (id, email, created_at) values
    ('${ANA}', 'ana@casa.cl', '2026-01-01T10:00:00Z'),
    ('${BETO}', 'beto@casa.cl', '2026-01-02T11:30:00Z');
  set role authenticated;
  select set_config('request.jwt.claim.sub', '${ANA}', false);
  select public.create_household('Casa de prueba', 'Ana');
  reset role;
  insert into public.household_members (household_id, user_id, display_name, birth_date, height_cm)
    select id, '${BETO}', 'Beto', '1990-05-04', 178.5 from public.households;
  insert into public.invitations (household_id, token_hash, expires_at, accepted_at, accepted_by)
    select id, 'hash-de-prueba', now() + interval '7 days', now(), '${BETO}' from public.households;
`;

/** Las cuentas tal como quedarían en un proyecto NUEVO tras crearlas a mano. */
const SEMBRAR_DESTINO = `
  insert into auth.users (id, email, created_at) values
    ('${ANA_NUEVA}', 'ana@casa.cl', '2026-08-01T09:00:00Z'),
    ('${BETO_NUEVO}', 'beto@casa.cl', '2026-08-01T09:01:00Z');
`;

/** La cadena que declara el harness. Fija a propósito: el test no adivina. */
const CADENA = MIGRACIONES.map((m) => path.basename(m));

let carpeta = "";
let rutaRespaldo = "";
let origen: BaseDesechable | null = null;
let destino: BaseDesechable | null = null;
let respaldo: Respaldo;

beforeAll(async () => {
  lib = (await import(/* @vite-ignore */ urlDe("respaldo-lib.mjs"))) as Lib;
  nucleo = (await import(/* @vite-ignore */ urlDe("respaldo-nucleo.mjs"))) as Nucleo;
  carpeta = mkdtempSync(path.join(os.tmpdir(), "respaldo-camino-real-"));

  // --- 1. Un "producción" de mentira, con datos adentro ---------------------
  origen = await lib.baseConMigraciones(CADENA);
  await origen.db.exec(SEMBRAR_ORIGEN);

  // --- 2. Sacarle un respaldo CON EL GENERADOR DE VERDAD --------------------
  //
  // Las mismas consultas y el mismo armador que usa `scripts/respaldo.mjs`. Si
  // el test escribiera su propio generador, el round-trip probaría el test.
  const lector = lib.ejecutorPglite(origen.db, "origen");
  const esquema = (await lector.ejecutar(lib.SQL_ESQUEMA))[0]!.esquema as {
    tablas: TablaDeclarada[];
    fks: unknown[];
  };
  const tablas = [...esquema.tablas.map((t) => ({ ...t, esquema: "public" })), lib.TABLA_AUTH_USERS];
  const datos = (await lector.ejecutar(lib.sqlFotoCompleta(tablas)))[0]!.datos as Record<string, Fila[]>;

  const { texto } = lib.armarArchivoDeRespaldo({
    tablas,
    datos,
    esquema,
    migraciones: lib.migracionesDelRepo(),
    proyectoRef: "proyectodeprueba",
    inventario: { estado: "LEIDO", objetos: [], binarios_incluidos: false },
    coherente: true,
  });

  rutaRespaldo = path.join(carpeta, "respaldo-de-prueba.ndjson");
  writeFileSync(rutaRespaldo, texto, { encoding: "utf8" });
  respaldo = lib.leerRespaldo(rutaRespaldo);

  // --- 3. El proyecto NUEVO: mismo esquema, cuentas con otros ids -----------
  destino = await lib.baseConMigraciones(CADENA);
  await destino.db.exec(SEMBRAR_DESTINO);
}, 180_000);

afterAll(async () => {
  await origen?.db.close();
  await destino?.db.close();
  if (carpeta) rmSync(carpeta, { recursive: true, force: true });
});

/** Lee del destino como postgres, sin RLS de por medio. */
async function delDestino<T = Fila>(sql: string): Promise<T[]> {
  const r = (await destino!.db.exec(sql)) as { rows: T[] }[];
  return r[r.length - 1]!.rows;
}

// ===========================================================================
// 1. EL CAMINO REAL, ESCRIBIENDO DE VERDAD
// ===========================================================================

describe("--destino supabase: el camino real, ejecutado de verdad", () => {
  it("restaura, reenlaza las cuentas y todo vuelve idéntico", async () => {
    const resultado = await nucleo.restaurar({
      respaldo,
      ejecutor: lib.ejecutorPglite(destino!.db, "destino de mentira"),
      modo: "real",
      base: destino,
      seco: false,
      aplicarPendientes: false,
      log: () => {},
    });

    expect(resultado.problemas).toEqual([]);
    expect(resultado.ok).toBe(true);
    // Lo que distingue este camino del ensayo: las cuentas cambiaron de id.
    expect(resultado.huboReenlace).toBe(true);
    // Y TODAS las tablas se compararon de verdad. Antes las que llevaban
    // cuentas reenlazadas se sumaban al conteo sin haber comparado nada.
    expect(resultado.tablasOk).toBe(resultado.plan.length);
    expect(resultado.huerfanos).toBe(0);
  }, 180_000);

  it("la ficha de cada integrante quedó colgando de SU cuenta nueva, no de la vieja", async () => {
    const filas = await delDestino<{ display_name: string; user_id: string | null }>(
      "select display_name, user_id::text as user_id from public.household_members order by display_name",
    );
    expect(filas).toEqual([
      { display_name: "Ana", user_id: ANA_NUEVA },
      { display_name: "Beto", user_id: BETO_NUEVO },
    ]);

    // La segunda columna que apunta a auth.users, y que el motor sólo descubre
    // leyendo las llaves foráneas que trae el respaldo.
    const invitacion = await delDestino<{ accepted_by: string | null }>(
      "select accepted_by::text as accepted_by from public.invitations",
    );
    expect(invitacion).toEqual([{ accepted_by: BETO_NUEVO }]);

    // Y NINGÚN id viejo sobrevivió en la base nueva.
    const viejos = await delDestino<{ n: string }>(
      `select count(*)::text as n from public.household_members
       where user_id::text in ('${ANA}', '${BETO}')`,
    );
    expect(viejos[0]!.n).toBe("0");
  });

  it("una tabla con cuentas reenlazadas que vuelve DISTINTA se caza igual", async () => {
    // Prueba por mutación, hecha sobre los datos y no sobre el código: se
    // ensucia household_members —la tabla que lleva la identidad de la ficha
    // clínica y la única que el reenlace toca— DESPUÉS del insert y ANTES de
    // la verificación.
    //
    // Con el código viejo esto pasaba en verde: `if (reenlazada) { avisos.push(
    // "hash no comparable"); tablasOk += 1; }` sumaba al conteo de «hash
    // idéntico» una tabla cuyo hash nunca se comparó. UNKNOWN presentado como
    // NORMAL, justo en las dos tablas que más importa mirar.
    const real = lib.ejecutorPglite(destino!.db, "destino que se ensucia");
    let ensuciada = false;
    const sucio: Ejecutor = {
      nombre: real.nombre,
      ejecutar: (sql) => real.ejecutar(sql),
      async escribir(sql) {
        const salida = await real.escribir(sql);
        if (!ensuciada && sql.includes('insert into "public"."household_members"')) {
          ensuciada = true;
          await real.escribir(
            "update public.household_members set display_name = 'Otra persona' where display_name = 'Ana';",
          );
        }
        return salida;
      },
    };

    const resultado = await nucleo.restaurar({
      respaldo,
      ejecutor: sucio,
      modo: "real",
      base: destino,
      seco: false,
      aplicarPendientes: false,
      log: () => {},
    });

    expect(ensuciada).toBe(true);
    expect(resultado.ok).toBe(false);
    expect(resultado.problemas.join("\n")).toMatch(/household_members: los datos VOLVIERON DISTINTOS/);
  }, 180_000);

  it("deja la base como estaba para el resto del archivo", async () => {
    // La prueba anterior dejó una fila sucia a propósito. Se restaura de nuevo,
    // limpio: un test que le deja basura al siguiente es otro falso verde.
    const resultado = await nucleo.restaurar({
      respaldo,
      ejecutor: lib.ejecutorPglite(destino!.db),
      modo: "real",
      base: destino,
      seco: false,
      aplicarPendientes: false,
      log: () => {},
    });
    expect(resultado.ok).toBe(true);
  }, 180_000);
});

// ===========================================================================
// 2. LO QUE PGLITE NO PUEDE PROBAR, PREGUNTADO ANTES DE BORRAR
// ===========================================================================

describe("el permiso para apagar las llaves foráneas se pregunta ANTES de borrar", () => {
  it("interpretarSonda distingue los cuatro casos, y ninguno se redondea a «sí»", () => {
    expect(lib.interpretarSonda([]).permitido).toBe(false);
    expect(lib.interpretarSonda([]).motivo).toMatch(/ninguna fila/);

    const sinColumna = lib.interpretarSonda([{ rol: "postgres" }]);
    expect(sinColumna.permitido).toBe(false);
    expect(sinColumna.motivo).toMatch(/session_replication_role/);

    // El peor caso: el SET no falla pero tampoco toma efecto. Si eso se diera
    // por bueno, la carga entraría con las llaves foráneas VIVAS y reventaría
    // a mitad, con la base ya borrada.
    const noTomo = lib.interpretarSonda([{ rol: "postgres", superusuario: "off", replicacion: "origin" }]);
    expect(noTomo.permitido).toBe(false);
    expect(noTomo.motivo).toMatch(/no tomó efecto/);

    expect(lib.interpretarSonda([{ rol: "postgres", replicacion: "replica" }]).permitido).toBe(true);
  });

  it("si el destino no deja hacer el SET, no se ejecuta ni un solo delete", async () => {
    const real = lib.ejecutorPglite(destino!.db, "destino sin permiso");
    const escrituras: string[] = [];
    const sinPermiso: Ejecutor = {
      nombre: real.nombre,
      async ejecutar(sql) {
        // PGlite corre como superusuario y SIEMPRE deja hacer el SET: acá se
        // finge la respuesta de un rol que no puede, que es lo que la
        // Management API de Supabase podría contestar y que un ensayo normal
        // jamás llegaría a ver.
        if (sql.includes("as replicacion")) {
          return [{ rol: "postgres", superusuario: "off", replicacion: "origin" }];
        }
        return real.ejecutar(sql);
      },
      async escribir(sql) {
        escrituras.push(sql);
        return [];
      },
    };

    await expect(
      nucleo.restaurar({
        respaldo,
        ejecutor: sinPermiso,
        modo: "real",
        base: destino,
        seco: false,
        aplicarPendientes: false,
        log: () => {},
      }),
    ).rejects.toThrow(/NO SE PUEDE APAGAR LA INTEGRIDAD REFERENCIAL/);

    expect(escrituras).toEqual([]);
  }, 180_000);
});

// ===========================================================================
// 3. EL MODO EN SECO: genera las sentencias y no escribe
// ===========================================================================

describe("modo en seco", () => {
  it("no escribe nada y devuelve las sentencias que habría corrido", async () => {
    const seco = nucleo.ejecutorEnSeco(lib.ejecutorPglite(destino!.db, "destino en seco"));

    const resultado = await nucleo.restaurar({
      respaldo,
      ejecutor: seco,
      modo: "real",
      base: destino,
      seco: true,
      aplicarPendientes: false,
      log: () => {},
    });

    expect(resultado.seco).toBe(true);
    expect(seco.sentencias.length).toBeGreaterThan(0);
    expect(seco.sentencias.join("\n")).toContain('delete from "public"."household_members"');

    // Y la base no se movió: el destino sigue con las filas del respaldo.
    const filas = await delDestino<{ n: string }>(
      "select count(*)::text as n from public.household_members",
    );
    expect(filas[0]!.n).toBe("2");
  }, 180_000);

  it("declara con qué id queda cada cuenta, para poder espejar el camino real", async () => {
    const resultado = await nucleo.restaurar({
      respaldo,
      ejecutor: nucleo.ejecutorEnSeco(lib.ejecutorPglite(destino!.db)),
      modo: "real",
      base: destino,
      seco: true,
      aplicarPendientes: false,
      log: () => {},
    });
    const porCorreo = new Map(resultado.cuentasDestino.map((c) => [c.email, c.id]));
    expect(porCorreo.get("ana@casa.cl")).toBe(ANA_NUEVA);
    expect(porCorreo.get("beto@casa.cl")).toBe(BETO_NUEVO);
  }, 180_000);
});

// ===========================================================================
// 4. UN BLOQUE AUSENTE NO SE LEE COMO UNA COMPROBACIÓN LIMPIA
// ===========================================================================

describe("lo que el archivo no trae no se da por comprobado", () => {
  /** Acá nadie debería llegar a hablar con una base. */
  const nadie: Ejecutor = {
    nombre: "nadie",
    ejecutar: () => Promise.reject(new Error("no se debía consultar la base")),
    escribir: () => Promise.reject(new Error("no se debía escribir")),
  };

  function sinBloque(clave: "fks" | "tablas" | "migraciones"): Respaldo {
    const copia = JSON.parse(JSON.stringify(respaldo)) as Respaldo;
    if (clave === "migraciones") delete (copia.cabecera as Record<string, unknown>).migraciones;
    else delete (copia.cabecera.esquema as unknown as Record<string, unknown>)[clave];
    return copia;
  }

  it("sin el bloque de llaves foráneas se planta, en vez de decir «0 huérfanos»", async () => {
    // Antes: `cabecera.esquema.fks ?? []` hacía que un archivo sin ese bloque
    // imprimiera «Llaves foráneas comprobadas: 0 · huérfanos: 0» y cerrara con
    // «RESTAURACIÓN OK … sin huérfanos». Ausencia total de comprobación
    // anunciada como comprobación limpia, en el archivo que decide si se
    // confía o no en el respaldo.
    await expect(
      nucleo.restaurar({ respaldo: sinBloque("fks"), ejecutor: nadie, modo: "real", log: () => {} }),
    ).rejects.toThrow(/llaves foráneas/i);
  });

  it("sin el esquema de las tablas tampoco arranca", async () => {
    await expect(
      nucleo.restaurar({ respaldo: sinBloque("tablas"), ejecutor: nadie, modo: "real", log: () => {} }),
    ).rejects.toThrow(/esquema de sus tablas/i);
  });

  it("sin la lista de migraciones tampoco", async () => {
    await expect(
      nucleo.restaurar({
        respaldo: sinBloque("migraciones"),
        ejecutor: nadie,
        modo: "real",
        log: () => {},
      }),
    ).rejects.toThrow(/lista de migraciones/i);
  });

  it("sin el bloque auth.users no se sabe a quién apuntaba cada ficha", async () => {
    // Cero cuentas en el respaldo y «no hacía falta reenlazar nada» son cosas
    // distintas. El `?? []` las hacía indistinguibles justo en la rama del
    // proyecto nuevo, que es donde el reenlace importa.
    const copia = JSON.parse(JSON.stringify(respaldo)) as Respaldo;
    copia.tablas = copia.tablas.filter((t) => t.nombre !== "users");
    await expect(
      nucleo.restaurar({
        respaldo: copia,
        ejecutor: lib.ejecutorPglite(destino!.db),
        modo: "real",
        base: destino,
        log: () => {},
      }),
    ).rejects.toThrow(/no trae el bloque `auth.users`/);
  }, 180_000);
});

// ===========================================================================
// 5. EL GENERADOR DE SENTENCIAS (puro: sin base de datos adentro)
// ===========================================================================

describe("el generador de sentencias de carga", () => {
  const TABLA: TablaDeclarada = {
    nombre: "member_conditions",
    esquema: "public",
    pk: ["id"],
    columnas: [
      { nombre: "id", tipo: "uuid" },
      { nombre: "member_id", tipo: "uuid" },
      { nombre: "grams", tipo: "numeric(12,4)" },
      { nombre: "diagnosed_on", tipo: "date" },
      { nombre: "created_at", tipo: "timestamp with time zone" },
    ],
  };

  it("una tabla vacía se borra y NO se le inventa un insert", () => {
    expect(nucleo.sqlCargarTabla(TABLA, [])).toBe('delete from "public"."member_conditions";');
  });

  it("borra antes de insertar y nombra todas las columnas guardadas", () => {
    const sql = nucleo.sqlCargarTabla(TABLA, [{ id: "x", member_id: "y" }]);
    expect(sql.indexOf("delete from")).toBeLessThan(sql.indexOf("insert into"));
    for (const c of TABLA.columnas) expect(sql).toContain(`"${c.nombre}"`);
    expect(sql).toContain("jsonb_array_elements");
  });

  it("cada tipo vuelve a entrar por el espejo exacto con que salió", () => {
    // El respaldo lee TODO como texto: un numeric que pase por JSON.parse
    // vuelve como coma flotante y deja de ser el mismo gramaje. El insert tiene
    // que devolverle su tipo. Y las fechas se formatean a mano en UTC porque
    // `::text` depende de DateStyle y del huso de la sesión, dos ajustes que el
    // respaldo no controla en el destino.
    const numero = TABLA.columnas[2]!;
    expect(lib.expresionLectura(numero)).toBe('t."grams"::text');
    expect(lib.expresionEscritura(numero)).toBe("(r->>'grams')::numeric(12,4)");

    const fecha = TABLA.columnas[3]!;
    expect(lib.expresionLectura(fecha)).toContain("to_char");
    expect(lib.expresionLectura(fecha)).toContain("YYYY-MM-DD");
    expect(lib.expresionEscritura(fecha)).toBe("(r->>'diagnosed_on')::date");

    const marca = TABLA.columnas[4]!;
    expect(lib.expresionLectura(marca)).toContain("at time zone 'UTC'");
    expect(lib.expresionEscritura(marca)).toBe("((r->>'created_at')::timestamp at time zone 'UTC')");
  });

  it("un user_id que el respaldo no conoce ABORTA, no se copia tal cual", () => {
    // Antes era `mapaUsuarios.get(viejo) ?? viejo`, tres líneas debajo de un
    // comentario que prometía lo contrario: el id se insertaba igual y sólo se
    // notaba después, en el conteo de huérfanos, con la base real ya reescrita.
    const definicion: TablaDeclarada = {
      nombre: "household_members",
      esquema: "public",
      pk: ["id"],
      columnas: [
        { nombre: "id", tipo: "uuid" },
        { nombre: "user_id", tipo: "uuid" },
      ],
    };
    const bloque: BloqueDeTabla = {
      tipo: "tabla",
      nombre: "household_members",
      esquema: "public",
      filas: 1,
      sha256: "",
      datos: [{ id: "fila-1", user_id: "id-que-nadie-declaro" }],
    };
    const comun = {
      orden: ["household_members"],
      esquemaRespaldo: new Map([["household_members", definicion]]),
      porNombre: new Map([["household_members", bloque]]),
      columnasDeUsuario: [{ tabla: "household_members", columna: "user_id" }],
    };

    expect(() =>
      nucleo.planDeCarga({ ...comun, mapaUsuarios: new Map([["otro-id", "nuevo"]]) }),
    ).toThrow(/NO conoce/);

    const plan = nucleo.planDeCarga({
      ...comun,
      mapaUsuarios: new Map([["id-que-nadie-declaro", "el-nuevo"]]),
    });
    expect(plan[0]!.filas).toEqual([{ id: "fila-1", user_id: "el-nuevo" }]);
  });
});

// ===========================================================================
// 6. HASHES: la comparación de la que cuelga todo el veredicto
// ===========================================================================

describe("la forma canónica y el hash", () => {
  const COLS: Columna[] = [
    { nombre: "id", tipo: "uuid" },
    { nombre: "grams", tipo: "numeric" },
  ];

  it("una columna ausente se escribe null explícito, no se salta", () => {
    expect(lib.canonizarFila({ id: "a" }, COLS)).toBe('{"id":"a","grams":null}');
  });

  it("el orden de las claves del objeto no cambia el hash: manda el esquema", () => {
    expect(lib.hashDeFilas([{ id: "a", grams: "1.0000" }], COLS)).toBe(
      lib.hashDeFilas([{ grams: "1.0000", id: "a" }], COLS),
    );
  });

  it("un gramo distinto cambia el hash", () => {
    expect(lib.hashDeFilas([{ id: "a", grams: "1.0000" }], COLS)).not.toBe(
      lib.hashDeFilas([{ id: "a", grams: "1.0001" }], COLS),
    );
  });

  it("null y ausente son lo mismo; null y cadena vacía NO", () => {
    expect(lib.hashDeFilas([{ id: "a" }], COLS)).toBe(lib.hashDeFilas([{ id: "a", grams: null }], COLS));
    expect(lib.hashDeFilas([{ id: "a", grams: null }], COLS)).not.toBe(
      lib.hashDeFilas([{ id: "a", grams: "" }], COLS),
    );
  });
});

// ===========================================================================
// 7. EL ARCHIVO: truncado, alterado, o el que sí sirve
// ===========================================================================

describe("leerRespaldo se niega a devolver un archivo en el que no se puede confiar", () => {
  function lineasDelRespaldo(): string[] {
    return readFileSync(rutaRespaldo, "utf8")
      .split("\n")
      .filter((l) => l !== "");
  }

  function escribir(nombre: string, contenido: string): string {
    const ruta = path.join(carpeta, nombre);
    writeFileSync(ruta, contenido, { encoding: "utf8" });
    return ruta;
  }

  it("sin la línea de cierre dice TRUNCADO", () => {
    const ruta = escribir("truncado.ndjson", lineasDelRespaldo().slice(0, -1).join("\n") + "\n");
    expect(() => lib.leerRespaldo(ruta)).toThrow(/TRUNCADO/);
  });

  it("un byte cambiado rompe el hash del contenido", () => {
    const copia = lineasDelRespaldo();
    const i = copia.findIndex((l) => l.includes("Casa de prueba"));
    // Si el nombre del hogar dejara de estar en el archivo, este test estaría
    // editando nada y pasaría por la razón equivocada. Que se caiga acá.
    expect(i).toBeGreaterThan(0);
    copia[i] = copia[i]!.replace("Casa de prueba", "Casa de otros");
    const ruta = escribir("alterado.ndjson", copia.join("\n") + "\n");
    expect(() => lib.leerRespaldo(ruta)).toThrow(/NO CALZA CON SU PROPIO HASH/);
  });

  it("el archivo íntegro sí se abre", () => {
    expect(lib.leerRespaldo(rutaRespaldo).cierre.filas).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 8. QUÉ MIGRACIONES TENÍA LA BASE CUANDO SE SACÓ EL RESPALDO
// ===========================================================================

describe("elegir el nivel del respaldo", () => {
  const todas: Migracion[] = ["0033_a.sql", "0034_b.sql", "0035_c.sql", "0036_d.sql"].map((archivo) => ({
    archivo,
    sha256: "x",
    sql: "",
  }));

  it("con empate elige la PRIMERA y lo dice en voz alta", () => {
    // 0033, 0034 y 0035 no cambian ninguna columna: mirando el catálogo son
    // indistinguibles. Quedarse con la última y llamarla «el esquema EXACTO»
    // hacía que el runbook mandara aplicar migraciones que producción no tenía,
    // con su relleno declarado corriendo sobre tablas vacías.
    const r = lib.elegirNivelDelRespaldo({
      todas,
      calces: ["0033_a.sql", "0034_b.sql", "0035_c.sql"],
      porLibro: null,
      calzaPorLibro: false,
      notasLibro: [],
    });
    expect(r.seleccion).toEqual(["0033_a.sql"]);
    expect(r.fuente).toBe("calce-de-esquema");
    expect(r.notas.join(" ")).toMatch(/3 niveles distintos/);
  });

  it("el libro de producción le gana al calce cuando reproduce el esquema", () => {
    const r = lib.elegirNivelDelRespaldo({
      todas,
      calces: ["0033_a.sql", "0034_b.sql", "0035_c.sql"],
      porLibro: ["0033_a.sql", "0034_b.sql", "0035_c.sql", "0036_d.sql"],
      calzaPorLibro: true,
      notasLibro: [],
    });
    expect(r.fuente).toBe("libro-de-produccion");
    expect(r.seleccion).toHaveLength(4);
  });

  it("si el libro y el esquema no se ponen de acuerdo, lo declara", () => {
    const r = lib.elegirNivelDelRespaldo({
      todas,
      calces: ["0034_b.sql"],
      porLibro: ["0033_a.sql"],
      calzaPorLibro: false,
      notasLibro: [],
    });
    expect(r.fuente).toBe("calce-de-esquema");
    expect(r.notas.join(" ")).toMatch(/dice una cosa y el esquema del respaldo dice otra/);
  });

  it("sin ningún calce NO se inventa un nivel: lo dice y usa todo", () => {
    const r = lib.elegirNivelDelRespaldo({
      todas,
      calces: [],
      porLibro: null,
      calzaPorLibro: false,
      notasLibro: [],
    });
    expect(r.fuente).toBe("sin-calce");
    expect(r.notas.join(" ")).toMatch(/NINGÚN punto de la cadena/);
  });
});

// ===========================================================================
// 9. DIFERENCIAS DE ESQUEMA
// ===========================================================================

describe("diferenciasDeEsquema mira más que el nombre y el tipo", () => {
  const tablaCon = (columnas: Columna[]): TablaDeclarada[] => [
    { nombre: "t", esquema: "public", pk: ["id"], columnas },
  ];

  it("iguales es iguales", () => {
    const cols: Columna[] = [{ nombre: "id", tipo: "uuid", obligatoria: true, con_default: false }];
    expect(lib.diferenciasDeEsquema(tablaCon(cols), tablaCon(cols))).toEqual([]);
  });

  it("caza tipo, obligatoriedad y valor por defecto", () => {
    const enRespaldo: Columna[] = [
      { nombre: "id", tipo: "uuid", obligatoria: true, con_default: false },
      { nombre: "source", tipo: "text", obligatoria: false, con_default: true },
    ];
    const enDestino: Columna[] = [
      { nombre: "id", tipo: "text", obligatoria: true, con_default: false },
      { nombre: "source", tipo: "text", obligatoria: true, con_default: false },
    ];
    const clases = lib
      .diferenciasDeEsquema(tablaCon(enDestino), tablaCon(enRespaldo))
      .map((d) => d.clase);
    expect(clases).toContain("tipo_distinto");
    expect(clases).toContain("obligatoriedad_distinta");
    expect(clases).toContain("default_distinto");
  });

  it("una columna derivada del destino no cuenta como columna que sobra", () => {
    expect(
      lib.diferenciasDeEsquema(
        tablaCon([
          { nombre: "id", tipo: "uuid" },
          { nombre: "calculada", tipo: "numeric", derivada: true },
        ]),
        tablaCon([{ nombre: "id", tipo: "uuid" }]),
      ),
    ).toEqual([]);
  });

  it("una tabla que falta y una que sobra se nombran las dos", () => {
    const dif = lib.diferenciasDeEsquema(
      [{ nombre: "otra", esquema: "public", pk: [], columnas: [] }],
      tablaCon([{ nombre: "id", tipo: "uuid" }]),
    );
    expect(dif.map((d) => d.clase).sort()).toEqual(["tabla_extra", "tabla_faltante"]);
  });
});

// ===========================================================================
// 10. DÓNDE PUEDE VIVIR UN ARCHIVO CON LA FICHA MÉDICA DE UNA FAMILIA
// ===========================================================================

describe("el respaldo no se guarda en cualquier parte", () => {
  it("dentro del repositorio, no", () => {
    expect(lib.motivoParaNoGuardarAca(path.resolve(__dirname, "../../.."))).toMatch(
      /DENTRO del repositorio/,
    );
  });

  it("en una carpeta que sincroniza sola con la nube, tampoco", () => {
    for (const nube of ["OneDrive", "Dropbox", "Google Drive", "iCloud"]) {
      expect(lib.motivoParaNoGuardarAca(path.join("D:", nube, "respaldos"))).toMatch(/sincroniza sola/);
    }
  });

  it("una carpeta local cualquiera sí sirve", () => {
    expect(lib.motivoParaNoGuardarAca(path.join("D:", "respaldos-mesa-familiar"))).toBeNull();
  });
});
