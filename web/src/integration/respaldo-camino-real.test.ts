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

import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  /** Lo que el ARCHIVO declara. No es lo mismo que lo que se escribió. */
  filas?: number;
  /** Lo que ESTE camino escribió de verdad: sale del plan, igual que las tablas. */
  filasCargadas: number;
  /** Lo que el archivo trae y este camino NO escribió, nombrado una por una. */
  tablasFueraDelPlan: { tabla: string; filas: number }[];
  esquemaComparadas: number;
  esquemaNoComparadas: string[];
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
  comprobarPermisoDeReplicacion(ejecutor: Ejecutor): Promise<{
    permitido: boolean;
    motivo: string | null;
    detalle: Fila | null;
    restablecido?: boolean;
    motivoRestablecer?: string | null;
  }>;
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

  // RUTAS ABSOLUTAS Y NEUTRAS AL SISTEMA. Antes decía `path.join("D:", …)`, que
  // en Windows es una ruta absoluta y en Linux es RELATIVA ("D:/OneDrive/…"):
  // `motivoParaNoGuardarAca` la resolvía contra el cwd —o sea, dentro del
  // repo— y el CI contestaba "DENTRO del repositorio" a las dos preguntas.
  // Verde acá, rojo en CI, sin que cambiara nada de lo que se prueba. Se parte
  // de `os.tmpdir()`, que es absoluto en cualquier sistema y nunca está dentro
  // del repositorio ni en una carpeta que sincronice sola.
  it("en una carpeta que sincroniza sola con la nube, tampoco", () => {
    for (const nube of ["OneDrive", "Dropbox", "Google Drive", "iCloud"]) {
      expect(lib.motivoParaNoGuardarAca(path.join(os.tmpdir(), nube, "respaldos"))).toMatch(
        /sincroniza sola/,
      );
    }
  });

  it("una carpeta local cualquiera sí sirve", () => {
    expect(lib.motivoParaNoGuardarAca(path.join(os.tmpdir(), "respaldos-mesa-familiar"))).toBeNull();
  });
});

// ===========================================================================
// 11. LA SESIÓN NO QUEDA CON LOS DISPARADORES APAGADOS
// ===========================================================================

/**
 * Lo que se vigila acá es la PROPIEDAD, no la ortografía.
 *
 * Durante una ronda entera el comentario de la sonda decía «sube el parámetro,
 * lo lee de vuelta y lo devuelve a `origin`» y el runbook lo repetía. Nadie lo
 * devolvía: `SQL_SONDA_REPLICACION` era el preámbulo más un `select`. El único
 * reset del motor iba por `escribir`, DESPUÉS de cargar, así que en `--en-seco`
 * —el modo que se corre contra producción prometiendo no escribirle una fila—
 * el envoltorio lo interceptaba y jamás se enviaba.
 *
 * Por eso ninguna de estas pruebas mira el texto del SQL ni la lista de
 * sentencias interceptadas: le PREGUNTAN a la base en qué quedó
 * `session_replication_role`. Un reset escrito de otra forma pasa igual; un
 * reset que no ocurre no pasa de ninguna forma.
 */
describe("session_replication_role vuelve a origin, y se comprueba preguntándole a la base", () => {
  async function rolDeReplicacion(): Promise<string> {
    const filas = await delDestino<{ v: string }>(
      "select current_setting('session_replication_role') as v",
    );
    return filas[0]!.v;
  }

  it("la sonda sola lo deja en origin (y declara que lo restableció)", async () => {
    const ejecutor = lib.ejecutorPglite(destino!.db, "destino de la sonda");
    const sonda = await nucleo.comprobarPermisoDeReplicacion(ejecutor);

    expect(sonda.permitido).toBe(true);
    expect(sonda.restablecido).toBe(true);
    expect(await rolDeReplicacion()).toBe("origin");
  }, 60_000);

  it("aunque la sonda falle, la sesión igual vuelve a origin", async () => {
    // El `finally` es el punto: si el reset colgara del camino feliz, un destino
    // que contesta cualquier cosa dejaría la sesión en `replica` para siempre.
    const real = lib.ejecutorPglite(destino!.db, "destino que contesta mal");
    const raro: Ejecutor = {
      nombre: real.nombre,
      async ejecutar(sql) {
        if (sql.includes("as replicacion")) {
          // Se deja que el SET del preámbulo SÍ corra (para que la sesión quede
          // efectivamente en `replica`) y recién después se contesta basura.
          await real.ejecutar(sql);
          return [];
        }
        return real.ejecutar(sql);
      },
      escribir: (sql) => real.escribir(sql),
    };

    const sonda = await nucleo.comprobarPermisoDeReplicacion(raro);
    expect(sonda.permitido).toBe(false);
    expect(sonda.restablecido).toBe(true);
    expect(await rolDeReplicacion()).toBe("origin");
  }, 60_000);

  it("en modo EN SECO la sesión no queda pegada en replica", async () => {
    // La sonda viaja por `ejecutar`, que el envoltorio en seco deja pasar a
    // propósito: en seco el SET a `replica` SÍ llega al destino. Si el reset
    // fuera una escritura, este modo sería justo el que deja producción con
    // todos los disparadores apagados.
    const seco = nucleo.ejecutorEnSeco(lib.ejecutorPglite(destino!.db, "destino en seco"));
    await nucleo.restaurar({
      respaldo,
      ejecutor: seco,
      modo: "real",
      base: destino,
      seco: true,
      aplicarPendientes: false,
      log: () => {},
    });

    // Y se comprueba contra la BASE, no contra `seco.sentencias`: ese arreglo es
    // justamente el que se tragaba el reset sin mandarlo.
    expect(await rolDeReplicacion()).toBe("origin");
  }, 180_000);

  it("después de una restauración real tampoco queda pegada", async () => {
    await nucleo.restaurar({
      respaldo,
      ejecutor: lib.ejecutorPglite(destino!.db),
      modo: "real",
      base: destino,
      seco: false,
      aplicarPendientes: false,
      log: () => {},
    });
    expect(await rolDeReplicacion()).toBe("origin");
  }, 180_000);
});

// ===========================================================================
// 12. LOS NÚMEROS DEL VEREDICTO SALEN DE LO QUE DE VERDAD SE MIRÓ
// ===========================================================================

describe("lo no comparado y lo no escrito se declaran, no se suman al verde", () => {
  it("el conteo del esquema cuenta las comparadas, no las de la cabecera", async () => {
    const resultado = await nucleo.restaurar({
      respaldo,
      ejecutor: lib.ejecutorPglite(destino!.db),
      modo: "real",
      base: destino,
      seco: false,
      aplicarPendientes: false,
      log: () => {},
    });

    const enCabecera = respaldo.cabecera.esquema.tablas;
    const dePublic = enCabecera.filter((t) => (t.esquema ?? "public") === "public");
    const fueraDePublic = enCabecera.filter((t) => (t.esquema ?? "public") !== "public");

    // La cifra que se anunciaba: `tablasCabecera.length`, que incluye auth.users.
    expect(fueraDePublic.length).toBeGreaterThan(0);
    expect(resultado.esquemaComparadas).toBe(dePublic.length);
    expect(resultado.esquemaComparadas).not.toBe(enCabecera.length);
    expect(resultado.esquemaNoComparadas).toContain("auth.users");
  }, 180_000);

  it("en modo real las filas anunciadas son las escritas, y auth.users se nombra aparte", async () => {
    const resultado = await nucleo.restaurar({
      respaldo,
      ejecutor: lib.ejecutorPglite(destino!.db),
      modo: "real",
      base: destino,
      seco: false,
      aplicarPendientes: false,
      log: () => {},
    });

    const enElPlan = new Set(resultado.plan.map((p) => p.tabla));
    expect(enElPlan.has("users")).toBe(false); // el camino real NO restaura cuentas

    // Las dos cifras del veredicto salen del MISMO plan.
    const sumaDelPlan = resultado.plan.reduce((a, p) => a + p.filas.length, 0);
    expect(resultado.filasCargadas).toBe(sumaDelPlan);

    // Y son MENOS que las del archivo, por las cuentas que nadie escribió.
    const bloqueUsuarios = respaldo.tablas.find((t) => t.nombre === "users")!;
    expect(bloqueUsuarios.filas).toBeGreaterThan(0);
    expect(respaldo.cierre.filas).toBe(sumaDelPlan + bloqueUsuarios.filas);
    expect(resultado.filasCargadas).toBeLessThan(respaldo.cierre.filas);

    // Lo que quedó fuera no desaparece: se nombra con su cuenta de filas.
    expect(resultado.tablasFueraDelPlan).toEqual([
      { tabla: "auth.users", filas: bloqueUsuarios.filas },
    ]);
  }, 180_000);

  it("en el ensayo, donde SÍ se restauran las cuentas, no queda nada fuera", async () => {
    const desechable = await lib.baseConMigraciones(CADENA);
    try {
      const resultado = await nucleo.restaurar({
        respaldo,
        ejecutor: lib.ejecutorPglite(desechable.db),
        modo: "ensayo",
        base: desechable,
        seco: false,
        aplicarPendientes: false,
        log: () => {},
      });
      expect(resultado.tablasFueraDelPlan).toEqual([]);
      expect(resultado.filasCargadas).toBe(respaldo.cierre.filas);

      // Y en el modo ensayo la sesión tampoco queda con los disparadores
      // apagados: se le pregunta a la base que se acaba de usar.
      const r = (await desechable.db.exec(
        "select current_setting('session_replication_role') as v",
      )) as { rows: { v: string }[] }[];
      expect(r[r.length - 1]!.rows[0]!.v).toBe("origin");
    } finally {
      await desechable.db.close();
    }
  }, 300_000);
});

// ===========================================================================
// 13. EL PUNTO DE ENTRADA DEVUELVE EL CÓDIGO QUE ELIGIÓ
// ===========================================================================

/**
 * `scripts/respaldo.mjs` es el paso 2 del runbook de desastre y lo que agenda la
 * tarea programada. El runbook promete: «termina con código distinto de cero
 * cuando algo sale mal». Eso es una promesa sobre el CÓDIGO DE SALIDA, y sólo se
 * comprueba corriendo el script y mirando el código de salida.
 *
 * Qué se rompía. `process.exit()` con un socket de `fetch` todavía abierto hace
 * reventar libuv en Windows («Assertion failed: !(handle->flags &
 * UV_HANDLE_CLOSING)») y el proceso se va con 127: el camino de ÉXITO de
 * `--sin-ensayo` reportaba falla. Y la cura a medias tampoco servía: con
 * `morir()` lanzando desde el tope de un módulo ESM, la excepción salía sin que
 * nadie la atrapara y Node imprimía la pila entera DESPUÉS de «EL RESPALDO SE
 * ESCRIBIÓ PERO NO SE PUDO RESTAURAR» —el mensaje más importante del sistema
 * sepultado bajo un volcado.
 *
 * Cómo se comprueba sin tocar producción: un preload levanta un Management API
 * de mentira en 127.0.0.1 y desvía `fetch` hacia allá. El socket es REAL —undici
 * de verdad, keep-alive de verdad—, que es justo lo que `process.exit()` deja a
 * medio cerrar. Verificado por mutación: reponiendo `process.exit(0)` en el
 * camino de éxito, esta corrida devuelve 127 y escupe la assertion de libuv.
 */
describe("respaldo.mjs devuelve el código de salida que dice devolver", () => {
  const RAIZ_REPO = path.resolve(__dirname, "../../..");
  let taller = "";
  let stubOk = "";
  let stubRoto = "";

  /** El Management API de mentira. `roto` decide si el inventario llega mal. */
  function preload(roto: boolean): string {
    return `
import http from "node:http";

const TABLAS = [{
  nombre: "hogares",
  pk: ["id"],
  columnas: [
    { nombre: "id", tipo: "uuid", derivada: false, identidad: false, obligatoria: true, con_default: true },
    { nombre: "nombre", tipo: "text", derivada: false, identidad: false, obligatoria: true, con_default: false },
  ],
}];

const ESQUEMA = {
  servidor: "PostgreSQL de mentira",
  base: "postgres",
  momento: "2026-09-01T00:00:00.000000",
  tablas: TABLAS,
  fks: [],
};

function responder(sql) {
  if (sql.includes("'servidor', version()")) return [{ esquema: ESQUEMA }];
  if (sql.includes("as inventario")) {
    return [{ inventario: { buckets: [], objetos: ${roto ? '"no es un arreglo"' : "[]"} } }];
  }
  if (sql.includes("as datos")) return [{ datos: { hogares: [], users: [] } }];
  return null;
}

const servidor = http.createServer((req, res) => {
  let cuerpo = "";
  req.on("data", (c) => (cuerpo += c));
  req.on("end", () => {
    let sql = "";
    try { sql = JSON.parse(cuerpo).query ?? ""; } catch { /* cuerpo ilegible */ }
    const salida = responder(sql);
    res.writeHead(salida === null ? 500 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(salida === null ? { message: "consulta no prevista" } : salida));
  });
});

await new Promise((listo) => servidor.listen(0, "127.0.0.1", listo));
const puerto = servidor.address().port;
servidor.unref();

const fetchReal = globalThis.fetch;
globalThis.fetch = (recurso, init) => {
  const u = new URL(String(recurso));
  if (u.hostname === "api.supabase.com") {
    return fetchReal("http://127.0.0.1:" + puerto + u.pathname, init);
  }
  return fetchReal(recurso, init);
};
`;
  }

  beforeAll(() => {
    taller = mkdtempSync(path.join(os.tmpdir(), "respaldo-salida-"));
    stubOk = path.join(taller, "api-falsa.mjs");
    stubRoto = path.join(taller, "api-falsa-rota.mjs");
    writeFileSync(stubOk, preload(false), "utf8");
    writeFileSync(stubRoto, preload(true), "utf8");
  });

  afterAll(() => {
    if (taller) rmSync(taller, { recursive: true, force: true });
  });

  function correr(stub: string, banderas: string[]) {
    const salida = path.join(taller, `salida-${Math.random().toString(36).slice(2)}`);
    mkdirSync(salida, { recursive: true });
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(stub).href,
        path.join(RAIZ_SCRIPTS, "respaldo.mjs"),
        "--salida",
        salida,
        ...banderas,
      ],
      {
        cwd: RAIZ_REPO,
        encoding: "utf8",
        env: {
          ...process.env,
          // Fijos y falsos: este script NUNCA habla con el proyecto real acá.
          SUPABASE_ACCESS_TOKEN: "sbp_estonoesuntokendeverdad",
          NEXT_PUBLIC_SUPABASE_URL: "https://proyectofalso.supabase.co",
        },
      },
    );
    return { ...r, texto: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  /** Lo que jamás puede acompañar a un mensaje del respaldo. */
  function sinVolcado(texto: string) {
    expect(texto).not.toContain("Assertion failed");
    expect(texto).not.toContain("UV_HANDLE_CLOSING");
    expect(texto).not.toContain("SalidaLimpia:");
    expect(texto).not.toContain("at ModuleJob.run");
  }

  it("camino de ÉXITO: 0, y ni una línea de volcado", () => {
    const r = correr(stubOk, ["--sin-ensayo"]);
    expect(r.texto).toContain("Respaldo escrito:");
    sinVolcado(r.texto);
    expect(r.status).toBe(0);
  }, 120_000);

  it("camino de ERROR después de los fetch: 1, con el motivo y sin volcado", () => {
    const r = correr(stubRoto, ["--sin-ensayo"]);
    // El inventario dice haberse leído y no trae la lista: se muere a propósito.
    expect(r.texto).toContain("no trae la lista de objetos que dice haber leído");
    sinVolcado(r.texto);
    expect(r.status).toBe(1);
  }, 120_000);

  it("respaldo-restaurar.mjs también: sus errores de argumentos salen sin pila", () => {
    // La cabecera de ese archivo prometía «se sale por `process.exitCode`, NUNCA
    // por `process.exit`» mientras llamaba a `morir()` en el tope del módulo:
    // `SalidaLimpia` salía sin que nadie la atrapara y el usuario recibía su
    // mensaje de uso con la pila de Node encima.
    const restaurar = path.join(RAIZ_SCRIPTS, "respaldo-restaurar.mjs");
    const correrRestaurar = (extra: string[]) =>
      spawnSync(process.execPath, [restaurar, ...extra], { cwd: RAIZ_REPO, encoding: "utf8" });

    const sinArchivo = correrRestaurar([]);
    const textoUso = `${sinArchivo.stdout ?? ""}${sinArchivo.stderr ?? ""}`;
    expect(textoUso).toContain("Uso: node scripts/respaldo-restaurar.mjs");
    sinVolcado(textoUso);
    expect(sinArchivo.status).toBe(1);

    const destinoRaro = correrRestaurar(["algo.ndjson", "--destino", "marte"]);
    const textoDestino = `${destinoRaro.stdout ?? ""}${destinoRaro.stderr ?? ""}`;
    expect(textoDestino).toContain("--destino sólo acepta");
    sinVolcado(textoDestino);
    expect(destinoRaro.status).toBe(1);
  }, 120_000);

  it("el ensayo que falla: 1, y el mensaje grande queda al final, limpio", () => {
    // El respaldo de mentira declara la tabla `hogares`, que no existe en la
    // cadena de migraciones: el ensayo aborta y el padre tiene que decirlo.
    const r = correr(stubOk, []);
    expect(r.texto).toContain("EL RESPALDO SE ESCRIBIÓ PERO NO SE PUDO RESTAURAR.");
    sinVolcado(r.texto);
    expect(r.status).toBe(1);
    // Y ese mensaje es lo ÚLTIMO que se ve: nada lo sepulta.
    const lineas = r.texto.trimEnd().split(String.fromCharCode(10));
    expect(lineas[lineas.length - 1]).toContain("hasta entender por qué falló el ensayo");
  }, 300_000);
});

// ===========================================================================
// 14. EL VEREDICTO IMPRESO, MEDIDO EN LA CORRIDA DE VERDAD
// ===========================================================================

/**
 * La línea que una persona lee a las tres de la mañana es
 * `RESTAURACIÓN OK: N filas en M tablas`, y esa línea la imprime el CLI, no el
 * motor. Vigilar sólo el número que devuelve el motor sería vigilar un lugar por
 * el que el defecto ya pasó: la versión rota tomaba las FILAS de `cierre.filas`
 * (el total del ARCHIVO, con `auth.users` adentro) y las TABLAS del plan (sin
 * `auth.users`), o sea dos universos distintos en la misma frase, y sumaba al
 * verde filas que nadie escribió.
 *
 * Acá se corre `respaldo-restaurar.mjs --destino supabase --si-estoy-seguro` de
 * punta a punta: un preload levanta un Management API de mentira que por dentro
 * es un Postgres de verdad (PGlite con la misma cadena de migraciones) y desvía
 * `fetch` hacia él. Producción no se toca; el camino sí es el completo, con su
 * reenlace de cuentas, su borrado, su insert y su veredicto impreso.
 */
describe("el CLI del camino real no anuncia filas que no escribió", () => {
  const RAIZ_REPO = path.resolve(__dirname, "../../..");
  let taller = "";
  let stub = "";

  const SEMBRAR_CUENTAS =
    "insert into auth.users (id, email, created_at) values " +
    `('${ANA_NUEVA}', 'ana@casa.cl', '2026-08-01T09:00:00Z'), ` +
    `('${BETO_NUEVO}', 'beto@casa.cl', '2026-08-01T09:01:00Z');`;

  beforeAll(() => {
    taller = mkdtempSync(path.join(os.tmpdir(), "respaldo-cli-real-"));
    stub = path.join(taller, "api-sobre-pglite.mjs");
    writeFileSync(
      stub,
      `
import http from "node:http";
import { pathToFileURL } from "node:url";

const lib = await import(pathToFileURL(process.env.RUTA_LIB).href);
const base = await lib.baseConMigraciones(JSON.parse(process.env.CADENA));
await base.db.exec(process.env.SEMBRAR);
const ejecutor = lib.ejecutorPglite(base.db);

const servidor = http.createServer((req, res) => {
  let cuerpo = "";
  req.on("data", (c) => (cuerpo += c));
  req.on("end", async () => {
    let sql = "";
    try { sql = JSON.parse(cuerpo).query ?? ""; } catch { /* cuerpo ilegible */ }
    try {
      const filas = await ejecutor.ejecutar(sql);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(filas));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: String(e && e.message ? e.message : e) }));
    }
  });
});

await new Promise((listo) => servidor.listen(0, "127.0.0.1", listo));
const puerto = servidor.address().port;
servidor.unref();

const fetchReal = globalThis.fetch;
globalThis.fetch = (recurso, init) => {
  const u = new URL(String(recurso));
  if (u.hostname === "api.supabase.com") {
    return fetchReal("http://127.0.0.1:" + puerto + u.pathname, init);
  }
  return fetchReal(recurso, init);
};
`,
      "utf8",
    );
  });

  afterAll(() => {
    if (taller) rmSync(taller, { recursive: true, force: true });
  });

  it("anuncia las filas del plan, y nombra aparte las que el archivo trae y nadie escribió", () => {
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(stub).href,
        path.join(RAIZ_SCRIPTS, "respaldo-restaurar.mjs"),
        rutaRespaldo,
        "--destino",
        "supabase",
        "--si-estoy-seguro",
        "--sobrescribir",
      ],
      {
        cwd: RAIZ_REPO,
        encoding: "utf8",
        env: {
          ...process.env,
          RUTA_LIB: path.join(RAIZ_SCRIPTS, "respaldo-lib.mjs"),
          CADENA: JSON.stringify(CADENA),
          SEMBRAR: SEMBRAR_CUENTAS,
          // El ref calza con el del respaldo para no mezclar avisos; el token es
          // falso y `fetch` nunca sale de 127.0.0.1.
          SUPABASE_ACCESS_TOKEN: "sbp_estonoesuntokendeverdad",
          NEXT_PUBLIC_SUPABASE_URL: "https://proyectodeprueba.supabase.co",
        },
      },
    );
    const texto = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(r.status).toBe(0);

    // Las cuentas del respaldo NO se escriben: se reenlazan.
    const usuarios = respaldo.tablas.find((t) => t.nombre === "users")!;
    const escritas = respaldo.cierre.filas - usuarios.filas;
    expect(usuarios.filas).toBeGreaterThan(0);

    const veredicto = texto.match(/RESTAURACIÓN OK: (\d+) filas en (\d+) tablas/);
    expect(veredicto).not.toBeNull();
    expect(Number(veredicto![1])).toBe(escritas);
    // Y NO el total del archivo, que es lo que se anunciaba antes.
    expect(Number(veredicto![1])).not.toBe(respaldo.cierre.filas);
    expect(Number(veredicto![2])).toBe(respaldo.cierre.tablas - 1);

    // Lo que quedó fuera se nombra con su cifra, en vez de desaparecer.
    expect(texto).toContain(`auth.users: ${usuarios.filas} fila(s) en el archivo, 0 escritas.`);

    // Y el conteo del esquema tampoco suma la tabla que nunca comparó.
    const comparadas = texto.match(/Esquema del destino compatible: (\d+) tablas comprobadas/);
    expect(comparadas).not.toBeNull();
    expect(Number(comparadas![1])).toBe(respaldo.cierre.tablas - 1);
    expect(texto).toContain("Fuera de la comparación");
  }, 600_000);
});
