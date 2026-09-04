import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { READ_RPCS } from "../domain/assistant/tool";
import { CONTRATO } from "./contrato-rpc";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * EL INVENTARIO DE RPC, CONTRACTUAL: una RPC nueva sin clasificar pone rojo el CI.
 *
 * La 0062 le quito a `anon` el EXECUTE sobre las 276 funciones SECURITY DEFINER
 * apoyandose en una allowlist VACIA: ninguna RPC de la app se llama sin sesion.
 * Eso era cierto el dia que se aplico. Lo que faltaba era que siguiera siendo
 * cierto manana, cuando alguien agregue una RPC y nadie se acuerde de mirar.
 *
 * ESTE ARCHIVO NACIO CON CUATRO AGUJEROS, y los cuatro los encontro una auditoria
 * posterior. Vale escribirlos porque son las formas tipicas de que un inventario
 * mienta por omision:
 *
 *   1. MIRABA POCO. Barria solo `src/app` y `src/lib`. Todo `src/domain` y
 *      `src/components` quedaba afuera.
 *   2. LEIA COMENTARIOS. Un `.rpc("x")` dentro de un comentario entraba al
 *      inventario como si fuera una llamada.
 *   3. EXIGIA EL PARENTESIS PEGADO. `.rpc<T>(...)`, `.rpc (...)` y un `.rpc(` con
 *      salto de linea desaparecian sin dejar rastro.
 *   4. DECLARABA LAS VARIABLES POR ARCHIVO. Una segunda `.rpc(variable)` en el
 *      mismo archivo heredaba la declaracion de la primera, en silencio.
 *
 * Ninguno era una brecha —el cierre de la 0062 recorre el catalogo, no esta
 * lista— pero un inventario incompleto es peor que ninguno: da confianza.
 *
 * Este archivo no interpreta JavaScript. Encuentra las llamadas, resuelve las de
 * nombre literal, y para las de nombre variable exige que esten DECLARADAS aca
 * abajo POR SITIO. Leerlas es trabajo de una persona, no de un regex que se
 * equivoque en silencio.
 */

const SRC = path.resolve(__dirname, "..");

/**
 * `src/integration` es el andamiaje de pruebas: sus `.rpc(` son fixtures, no
 * llamadas de la aplicacion. Es la UNICA carpeta excluida, y se nombra aca para
 * que agregar otra cueste una decision y no un descuido.
 */
const CARPETAS_FUERA = new Set(["integration"]);

/**
 * Llamadas con nombre VARIABLE, declaradas por ARCHIVO y por IDENTIFICADOR.
 *
 * Indexado solo por archivo, una segunda llamada variable en el mismo archivo
 * tomaba los candidatos de la primera y nadie se enteraba. La primera correccion
 * fue poner la LINEA en la clave, y estuvo mal: cualquiera que agregara un
 * comentario mas arriba movia la linea y rompia la declaracion. Fallaba fuerte,
 * no en silencio, pero por un motivo que no tiene nada que ver con lo que este
 * archivo vigila — y un guardian que se queja de cosas ajenas se termina
 * silenciando.
 *
 * La clave es `archivo:identificador`. Dos variables distintas en el mismo
 * archivo tienen nombres distintos; dos usos de LA MISMA variable comparten
 * candidatos, que es justamente lo correcto. Y sobrevive a que el codigo se
 * mueva de linea.
 */
const NOMBRES_VARIABLES: Readonly<Record<string, string[]>> = {
  // `declararOtraComida`: la persona anota una comida fuera del plan, y el
  // destino depende de si fue en casa o afuera.
  "app/comi/actions.ts:rpc": ["log_intake_away", "log_intake_off_plan"],
};

/**
 * Sitios que el barrido ve y que NO son llamadas de la aplicacion.
 *
 * Se declaran uno por uno, con su motivo. Una lista de exclusion sin motivo es
 * el lugar donde se esconde la llamada que no queriamos mirar.
 */
const ARCHIVOS_QUE_NO_CUENTAN: Readonly<Record<string, string>> = {
  // Fixture de NO-compilacion: el cuerpo de `rpcFueraDeLaListaBlancaNoCompila`
  // existe para que `tsc` lo rechace. Nunca se ejecuta.
  "domain/assistant/tipos-imposibles.ts": "fixture de error de compilacion",
};

/**
 * Saca comentarios antes de buscar. Sin esto, la linea de `tool.ts` que
 * DOCUMENTA la lista blanca se leia como una llamada. Un inventario que se cree
 * los comentarios inventa RPC.
 */
function sinComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function archivos(raiz: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(raiz)) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) {
      if (CARPETAS_FUERA.has(nombre)) continue;
      out.push(...archivos(ruta));
    } else if (/\.(tsx?|mts|mjs|js)$/.test(nombre) && !/\.test\./.test(nombre)) {
      out.push(ruta);
    }
  }
  return out;
}

interface Llamada {
  rpc: string;
  sitio: string;
}

/**
 * `\s*` en los tres huecos y el generico opcional: `.rpc<T>(x)`, `.rpc (x)` y un
 * `.rpc(` cortado por un salto de linea son la misma llamada, y las tres formas
 * aparecen cuando alguien corre Prettier con otro ancho de linea.
 */
const LLAMADA = /\.rpc\s*(?:<[^>]*>)?\s*\(\s*([^,)\s]+)/g;

function llamadas(): { resueltas: Llamada[]; sinDeclarar: string[] } {
  const resueltas: Llamada[] = [];
  const sinDeclarar: string[] = [];

  for (const ruta of archivos(SRC)) {
    const rel = path.relative(SRC, ruta).split(path.sep).join("/");
    if (ARCHIVOS_QUE_NO_CUENTAN[rel] !== undefined) continue;
    const fuente = sinComentarios(readFileSync(ruta, "utf8"));
    for (const m of fuente.matchAll(LLAMADA)) {
      const arg = m[1]!;
      const linea = fuente.slice(0, m.index).split(String.fromCharCode(10)).length;
      const sitio = `${rel}:${linea}`;

      const literal = arg.match(/^["'`]([a-z_0-9]+)["'`]$/);
      if (literal) {
        resueltas.push({ rpc: literal[1]!, sitio });
        continue;
      }
      const declarados = NOMBRES_VARIABLES[`${rel}:${arg}`];
      if (declarados === undefined) {
        sinDeclarar.push(`${sitio} — .rpc(${arg}) con nombre variable, sin declarar`);
        continue;
      }
      for (const rpc of declarados) resueltas.push({ rpc, sitio });
    }
  }
  return { resueltas, sinDeclarar };
}

/** Todo lo que la app puede llamar: lo barrido mas lo que autoriza el asistente. */
function inventario(): string[] {
  return [...new Set([...llamadas().resueltas.map((l) => l.rpc), ...READ_RPCS])].sort();
}

let base: Harness;

beforeAll(async () => {
  base = await levantarBase({ conSeeds: false });
}, 120_000);

afterAll(async () => {
  await base?.cerrar();
});

describe("inventario de RPC: nada llamable sin clasificar", () => {
  it("toda llamada de nombre VARIABLE está declarada con sus candidatos", () => {
    // La primera compuerta, y la que hace mantenible al resto: si alguien
    // escribe `.rpc(algo)` sin declarar a qué resuelve, este test lo dice con
    // archivo y línea en vez de dejar la RPC fuera del inventario en silencio.
    expect(llamadas().sinDeclarar).toEqual([]);
  });

  it("el barrido encuentra RPC de verdad, y encuentra la de nombre variable", () => {
    // UN INVENTARIO VACÍO APRUEBA TODO. Sin esto, un cambio de estilo en las
    // llamadas dejaría la lista en cero y todos los tests de abajo pasarían por
    // no haber mirado nada.
    const { resueltas } = llamadas();
    expect(resueltas.length, "el barrido dejó de encontrar llamadas .rpc(").toBeGreaterThan(70);
    expect(
      resueltas.map((l) => l.rpc),
      "la llamada de nombre variable dejó de resolverse: log_intake_away no está",
    ).toContain("log_intake_away");
  });

  it("toda RPC que la app llama EXISTE en el esquema", async () => {
    const usadas = inventario();
    const enBase = new Set(
      (
        await base.filas<{ proname: string }>(
          `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'`,
        )
      ).map((f) => f.proname),
    );
    expect(usadas.filter((r) => !enBase.has(r))).toEqual([]);
  });

  it("NINGUNA RPC que la app llama es ejecutable por anon", async () => {
    /**
     * LA PROPIEDAD QUE LA 0062 COMPRÓ, AFIRMADA SOBRE LA LISTA REAL DE LA APP.
     *
     * El guardián de seguridad ya afirma "ninguna SECURITY DEFINER es ejecutable
     * por anon", que es más amplio. Esta afirmación es más ESTRECHA y por eso
     * vale aparte: recorre lo que la app de verdad llama —incluida la de nombre
     * variable— y exige que nada de eso quede abierto. Si mañana alguien agrega
     * una RPC y su migración no la cierra, acá se ve con el nombre puesto.
     */
    const usadas = inventario();
    expect(usadas.length, "no hay RPC que comprobar").toBeGreaterThan(70);

    const abiertas = await base.filas<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)
          and has_function_privilege('anon', p.oid, 'execute')`,
      [usadas],
    );
    expect(
      abiertas.map((f) => f.proname).sort(),
      "estas RPC de la app siguen siendo ejecutables por anon",
    ).toEqual([]);
  });

  it("toda RPC que la app llama SÍ es ejecutable por authenticated", async () => {
    // La otra mitad, y la que impide que el endurecimiento se pase de largo:
    // cerrar anon no puede haber cerrado la app. Una RPC que la app llama y
    // `authenticated` no puede ejecutar es una pantalla rota.
    const usadas = inventario();
    const cerradas = await base.filas<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)
          and not has_function_privilege('authenticated', p.oid, 'execute')`,
      [usadas],
    );
    expect(
      cerradas.map((f) => f.proname).sort(),
      "la app llama estas RPC y authenticated NO puede ejecutarlas",
    ).toEqual([]);
  });

  it("anon no puede entrar al esquema `app`", async () => {
    const r = await base.fila<{ usa: boolean }>(
      "select has_schema_privilege('anon', 'app', 'usage') as usa",
    );
    expect(r?.usa, "anon recuperó el USAGE sobre el esquema interno").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §5 — el contrato: una RPC nueva sin clasificar rompe el CI
// ---------------------------------------------------------------------------

describe("§5 — una RPC nueva sin clasificar rompe el CI", () => {
  it("toda RPC del inventario esta CLASIFICADA", () => {
    const sinClasificar = inventario().filter((r) => CONTRATO[r] === undefined);
    expect(
      sinClasificar,
      "estas RPC las usa la app y nadie declaro su rol: agregalas a CONTRATO",
    ).toEqual([]);
  });

  it("el contrato no tiene entradas MUERTAS", () => {
    // La otra mitad: un contrato que solo crece termina describiendo una app que
    // ya no existe, y entonces sus afirmaciones se vuelven decorativas.
    const inv = new Set(inventario());
    const muertas = Object.keys(CONTRATO).filter((r) => !inv.has(r));
    expect(muertas, "el contrato clasifica RPC que la app ya no llama").toEqual([]);
  });

  it("ninguna clasificacion se contradice con lo que hace la base", async () => {
    // El contrato no vale por estar escrito: cada campo se contrasta contra los
    // privilegios reales de la cadena completa.
    const problemas: string[] = [];
    for (const [rpc, c] of Object.entries(CONTRATO)) {
      const f = await base.fila<{ anon: boolean; auth: boolean }>(
        `select has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1 limit 1`,
        [rpc],
      );
      if (f === null) {
        problemas.push(`${rpc}: clasificada pero NO existe en el esquema`);
        continue;
      }
      if (f.anon !== c.anonimo_permitido) {
        problemas.push(`${rpc}: anon=${f.anon} y el contrato dice ${c.anonimo_permitido}`);
      }
      if (c.rol === "authenticated" && !f.auth) {
        problemas.push(`${rpc}: el contrato la da a authenticated y authenticated NO puede`);
      }
    }
    expect(problemas).toEqual([]);
  });

  it("las RPC de lectura del asistente son de LECTURA, como promete su comentario", async () => {
    /**
     * `domain/assistant/tool.ts` dice, sobre READ_RPCS: "La guarda de esquema
     * verifica contra pg_proc que cada funcion aca sea stable o immutable".
     *
     * ESA GUARDA NO EXISTIA. `grep provolatile` sobre el repo entero no devolvia
     * nada: era una promesa escrita en un comentario, que es la peor clase de
     * guardian — el que hace creer que estas cubierto.
     *
     * Aca esta. `provolatile` es 'i' (immutable), 's' (stable) o 'v' (volatile);
     * una funcion volatil puede escribir, y el asistente tiene prohibido escribir
     * sin pasar por una server action.
     */
    const volatiles = await base.filas<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1) and p.provolatile = 'v'`,
      [[...READ_RPCS]],
    );
    expect(
      volatiles.map((f) => f.proname),
      "una RPC de LECTURA del asistente es volatil: puede escribir",
    ).toEqual([]);

    // Y que existan: un `any()` contra nombres mal escritos tambien devuelve
    // cero volatiles, y el test pasaria sin haber mirado ninguna funcion.
    const existen = await base.filas<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)`,
      [[...READ_RPCS]],
    );
    expect([...new Set(existen.map((f) => f.proname))].sort()).toEqual([...READ_RPCS].sort());
  });
});

describe("los cuatro agujeros que tenia este guardian, cerrados", () => {
  it("mira TODO src, no solo app y lib", () => {
    // Agujero #1. Mientras el alcance eran dos carpetas, una llamada en
    // `src/domain` no existia para este archivo.
    const fuera = archivos(SRC)
      .map((r) => path.relative(SRC, r).split(path.sep).join("/"))
      .filter((r) => !r.startsWith("app/") && !r.startsWith("lib/"));
    expect(fuera.length, "el barrido volvio a mirar solo app/ y lib/").toBeGreaterThan(50);
  });

  it("los comentarios NO entran al inventario", () => {
    // Agujero #2. Se afirma sobre una cadena de prueba para que el test no
    // dependa de que un comentario del repo siga escrito igual.
    const conComentario =
      '/** llama a .rpc("inventada_en_comentario") */' +
      String.fromCharCode(10) +
      'await db.rpc("real");';
    const limpio = sinComentarios(conComentario);
    expect(limpio).not.toContain("inventada_en_comentario");
    expect(limpio).toContain("real");
    expect(inventario()).not.toContain("inventada_en_comentario");
  });

  it("`.rpc<T>(`, `.rpc (` y `.rpc` con salto de linea se ven igual", () => {
    // Agujero #3, afirmado sobre las cuatro formas.
    const formas = [
      'db.rpc("uno")',
      'db.rpc<Fila>("dos")',
      'db.rpc ("tres")',
      'db.rpc(' + String.fromCharCode(10) + '  "cuatro"',
    ].join(String.fromCharCode(10));
    const vistos = [...formas.matchAll(LLAMADA)].map((m) => m[1]!.replace(/["'`]/g, ""));
    expect(vistos).toEqual(["uno", "dos", "tres", "cuatro"]);
  });

  it("las variables se declaran por archivo Y por identificador", () => {
    // Agujero #4. La clave nombra el archivo y la variable, no solo el archivo:
    // dos `.rpc(variable)` distintas en un mismo archivo ya no se confunden.
    for (const clave of Object.keys(NOMBRES_VARIABLES)) {
      expect(clave, "una clave de NOMBRES_VARIABLES no nombra el identificador").toMatch(
        /^[^:]+\.tsx?:[A-Za-z_$][\w$]*$/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §13 — INTENTOS DE MUTACIÓN ANÓNIMA, ejecutados de verdad
// ---------------------------------------------------------------------------

describe("§13 — anon intenta mutar y no lo consigue", () => {
  /**
   * NO ALCANZA CON PREGUNTARLE AL CATÁLOGO.
   *
   * Los tests de arriba leen `has_function_privilege`, que es lo que el catálogo
   * DICE. Acá se intenta de verdad: se cuenta cada tabla, se toma el rol `anon`,
   * se ejecuta una batería de escrituras y llamadas, y se vuelve a contar. Si
   * algo hubiera pasado, el censo cambia y no hay interpretación posible.
   *
   * Los datos son SINTÉTICOS y viven en una base efímera. Nada de esto toca el
   * hogar real ni datos clínicos de nadie.
   */

  let censoAntes: Record<string, string>;
  let hogar: { householdId: string; memberId: string };

  async function tablas(): Promise<string[]> {
    const f = await base.filas<{ t: string }>(
      `select tablename as t from pg_tables where schemaname = 'public' order by 1`,
    );
    return f.map((r) => r.t);
  }

  /**
   * POR CONTENIDO, no por cantidad.
   *
   * La primera version contaba filas — y este mismo bloque intenta
   * `update public.households set name = 'robado'`. Contar filas NO VE UN
   * UPDATE: si ese intento hubiera funcionado, el censo daba identico y el test
   * pasaba en verde sobre una escritura real, justo en el caso que existe para
   * atrapar. El hash del contenido es lo que hace falta para poder decir
   * "antes == despues".
   */
  async function censo(): Promise<Record<string, string>> {
    const ts = await tablas();
    const sql = ts
      .map(
        (t) =>
          `select '${t}' as t, count(*)::text || ':' ||
                  coalesce(md5(string_agg(x::text, '|' order by x::text)), 'vacia') as huella
             from public.${t} x`,
      )
      .join(" union all ");
    const f = await base.filas<{ t: string; huella: string }>(sql);
    return Object.fromEntries(f.map((r) => [r.t, r.huella]));
  }

  beforeAll(async () => {
    hogar = await crearHogar(base, "00000000-0000-4000-8000-0000000000a1", "Hogar Sintético", "Sintética");
    censoAntes = await censo();
  }, 120_000);

  it("hay filas que perder: el censo no está vacío", async () => {
    // UN CENSO EN CERO SE CONSERVA SOLO. Sin esto, "antes == después" sería
    // cierto por no haber nada, y el test aprobaría una base sin protección.
    const conFilas = Object.values(censoAntes).filter((h) => !h.startsWith("0:")).length;
    expect(conFilas, "no se sembro nada: el test no puede probar que nada se perdio").toBeGreaterThan(3);
  });

  it("anon: toda escritura y toda RPC FALLAN, y el censo queda idéntico", async () => {
    const intentos: { que: string; sql: string; params: unknown[] }[] = [
      { que: "insert households", sql: "insert into public.households (name) values ('intruso')", params: [] },
      { que: "update households", sql: "update public.households set name = 'robado'", params: [] },
      { que: "delete households", sql: "delete from public.households", params: [] },
      { que: "delete household_members", sql: "delete from public.household_members", params: [] },
      {
        que: "rpc log_intake",
        sql: "select public.log_intake($1, '[]'::jsonb, current_date, 'LUNCH', null)",
        params: [hogar.memberId],
      },
      {
        que: "rpc log_intake_away",
        sql: "select public.log_intake_away($1, '[]'::jsonb, current_date, 'LUNCH', null)",
        params: [hogar.memberId],
      },
      {
        que: "rpc create_household",
        sql: "select public.create_household('intruso', 'intruso')",
        params: [],
      },
      { que: "rpc ensure_weekly_plan", sql: "select public.ensure_weekly_plan($1, current_date)", params: [hogar.householdId] },
    ];

    const pasaron: string[] = [];
    await base.db.exec("set role anon;");
    try {
      for (const i of intentos) {
        try {
          await base.db.query(i.sql, i.params);
          // Llegar acá es que NO se levantó error. Para una escritura eso puede
          // ser RLS filtrando (0 filas) y no es brecha; para una RPC, ejecutar
          // sin error SÍ lo es. Se anota y se decide abajo, con el censo.
          pasaron.push(i.que);
        } catch {
          /* rechazado: es lo que se espera */
        }
      }
    } finally {
      await base.db.exec("reset role;");
    }

    expect(
      pasaron.filter((q) => q.startsWith("rpc ")),
      "anon ejecutó estas RPC sin que la base lo rechazara",
    ).toEqual([]);

    const censoDespues = await censo();
    const cambiadas = Object.keys(censoAntes).filter((t) => censoAntes[t] !== censoDespues[t]);
    expect(cambiadas, "estas tablas cambiaron de contenido: anon consiguió escribir").toEqual([]);
  });

  it("anon: los SELECT no devuelven ni una fila del hogar", async () => {
    /**
     * La otra mitad de §13: no basta con que no pueda escribir. Leer la mesa de
     * la familia sin sesion seria la misma fuga por otra puerta.
     *
     * La primera version de este test exigia "devuelve cero filas", dando por
     * hecho que la RLS filtraria. La base contesto algo MEJOR: `permission
     * denied for table households` — anon no tiene ni SELECT, asi que la RLS ni
     * siquiera llega a evaluarse. Se acepta cualquiera de las dos negativas y se
     * afirma lo unico que de verdad importa: que no salga ni una fila.
     */
    const leidas: string[] = [];
    await base.db.exec("set role anon;");
    try {
      for (const t of ["households", "household_members", "consumption_logs"]) {
        try {
          const f = await base.filas<{ n: number }>(`select count(*)::int as n from public.${t}`);
          if ((f[0]?.n ?? 0) > 0) leidas.push(`${t}: ${f[0]?.n} filas`);
        } catch {
          /* permission denied: la negativa mas fuerte */
        }
      }
    } finally {
      await base.db.exec("reset role;");
    }
    expect(leidas, "anon leyo filas del hogar").toEqual([]);
  });

});

// ---------------------------------------------------------------------------
// §4 — la unica ruta que PARECE previa a la sesion
// ---------------------------------------------------------------------------

describe("§4 — /invite/[token] tampoco funciona sin sesion", () => {
  /**
   * De las 89 llamadas a RPC de la app, 79 salen de server actions y 10 de
   * server components: NINGUNA sale del bundle del navegador. Queda una sola
   * ruta que por su naturaleza se visita antes de pertenecer al hogar —aceptar
   * una invitacion— y por eso es la unica que valia la pena mirar de cerca.
   *
   * No necesita RPC anonima: `accept_invitation` empieza rechazando cuando no
   * hay `auth.uid()`. Quien recibe una invitacion tiene que crear su cuenta y
   * entrar antes; recien despues el enlace hace algo. La guarda vive DENTRO de
   * la funcion, que es donde no se puede saltar desde el cliente.
   */
  it("`accept_invitation` exige sesion aunque el rol pueda ejecutarla", async () => {
    let mensaje = "";
    await base.db.exec("set role authenticated;");
    try {
      // `authenticated` SI tiene el EXECUTE (lo afirma el test de arriba), asi
      // que lo que rechace acá no es el privilegio: es la guarda de la funcion.
      await base.db.query("select set_config('request.jwt.claim.sub', '', false)");
      await base.db.query("select public.accept_invitation('da-lo-mismo', 'Intruso')");
    } catch (e) {
      mensaje = String((e as Error).message ?? e);
    } finally {
      await base.db.exec("reset role;");
    }
    expect(mensaje, "accept_invitation acepto correr sin sesion").toContain("authentication required");
  });

  it("anon no puede ni siquiera intentarlo", async () => {
    let fallo = false;
    await base.db.exec("set role anon;");
    try {
      await base.db.query("select public.accept_invitation('da-lo-mismo', 'Intruso')");
    } catch {
      fallo = true;
    } finally {
      await base.db.exec("reset role;");
    }
    expect(fallo, "anon ejecuto accept_invitation").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// La prueba de que el guardián tiene dientes
// ---------------------------------------------------------------------------

describe("antes de la 0062 esto MISMO estaba abierto", () => {
  /**
   * Un test que afirma "la lista está vacía" sobre una base donde nunca estuvo
   * llena no prueba nada: pasaría igual si la consulta estuviera mal escrita.
   *
   * Acá se levanta la cadena CORTADA en la 0061 —el estado exacto de producción
   * la semana pasada— y se corre la MISMA consulta. Tiene que devolver muchas.
   * Eso mide lo que compró la 0062 y, de paso, demuestra que la consulta sabe
   * encontrar una función abierta cuando la hay.
   */
  let vieja: Harness;

  beforeAll(async () => {
    vieja = await levantarBase({ hasta: "0061", conSeeds: false });
  }, 120_000);

  afterAll(async () => {
    await vieja?.cerrar();
  });

  it("§10 — para `authenticated`, el antes y el después son IDÉNTICOS", async () => {
    /**
     * La compatibilidad, medida en vez de supuesta.
     *
     * Un endurecimiento que además cierre algo a quien SÍ tiene sesión rompe
     * pantallas, y se descubriría en producción con la familia adentro. Se
     * compara la lista completa de RPC ejecutables por `authenticated` antes y
     * después: tienen que ser la misma, nombre por nombre.
     *
     * El test de arriba ya afirma que después están todas abiertas; éste afirma
     * que ninguna se abrió de más, que es el otro modo de falla.
     */
    const usadas = inventario();
    const consulta = `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)
          and has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`;
    const antes = (await vieja.filas<{ proname: string }>(consulta, [usadas])).map((f) => f.proname);
    const despues = (await base.filas<{ proname: string }>(consulta, [usadas])).map((f) => f.proname);
    expect(antes.length, "no se comparó nada").toBeGreaterThan(70);
    expect(despues, "la 0062 le cambió a `authenticated` lo que puede ejecutar").toEqual(antes);
  });

  it("sobre la base en 0061, anon SÍ podía ejecutar RPC de la app", async () => {
    const usadas = inventario();
    const abiertas = await vieja.filas<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)
          and has_function_privilege('anon', p.oid, 'execute')`,
      [usadas],
    );
    expect(
      abiertas.length,
      "la consulta no encuentra funciones abiertas ni donde las hay: está mal escrita",
    ).toBeGreaterThan(20);
  });
});
