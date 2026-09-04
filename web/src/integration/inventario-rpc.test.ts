import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * EL INVENTARIO DE RPC, CONTRACTUAL: una RPC nueva sin clasificar pone rojo el CI.
 *
 * La 0062 le quitó a `anon` el EXECUTE sobre las 276 funciones SECURITY DEFINER
 * apoyándose en una allowlist VACÍA: ninguna RPC de la app se llama sin sesión.
 * Eso era cierto el día que se aplicó. Lo que faltaba era que siguiera siendo
 * cierto mañana, cuando alguien agregue una RPC y nadie se acuerde de mirar.
 *
 * POR QUÉ NO ALCANZA UN GREP DE `.rpc("literal"`:
 *
 * Buscando literales se pierde el nombre VARIABLE, y el repo tiene uno:
 *
 *     const rpc = donde === "AFUERA" ? "log_intake_away" : "log_intake_off_plan";
 *     await db.rpc(rpc, { … });                    // comi/actions.ts
 *
 * `log_intake_away` no aparecía en ningún inventario por eso. Ahí no pasó nada
 * —las tres quedaron cerradas a anon igual, porque el cierre recorre el catálogo
 * y no la lista de la app— pero el inventario que decidía la allowlist estaba
 * incompleto, y un inventario incompleto es peor que ninguno: da confianza.
 *
 * Este archivo no intenta interpretar JavaScript. Encuentra TODA llamada a
 * `.rpc(`, resuelve las de nombre literal, y para las de nombre variable exige
 * que estén DECLARADAS acá abajo con sus candidatos. Si aparece una variable sin
 * declarar, falla nombrando archivo y línea: leerla es trabajo de una persona,
 * no de un regex que se equivoque en silencio.
 */

const APP = path.resolve(__dirname, "../app");
const LIB = path.resolve(__dirname, "../lib");
const RAIZ_WEB = path.resolve(__dirname, "../..");

/**
 * Llamadas con nombre VARIABLE, con los nombres que puede tomar.
 *
 * Cada entrada es una decisión humana: alguien leyó el código y escribió a qué
 * puede resolver. Una nueva sin declarar rompe el test.
 */
const NOMBRES_VARIABLES: Readonly<Record<string, string[]>> = {
  // `declararOtraComida`: la persona anota una comida fuera del plan, y el
  // destino depende de si fue en casa o afuera.
  "src/app/comi/actions.ts": ["log_intake_away", "log_intake_off_plan"],
};

function archivos(raiz: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(raiz)) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) out.push(...archivos(ruta));
    else if (/\.tsx?$/.test(nombre) && !/\.test\./.test(nombre)) out.push(ruta);
  }
  return out;
}

interface Llamada {
  rpc: string;
  archivo: string;
  linea: number;
}

/** Toda llamada a `.rpc(`, con su nombre resuelto o su archivo si es variable. */
function llamadas(): { resueltas: Llamada[]; sinDeclarar: string[] } {
  const resueltas: Llamada[] = [];
  const sinDeclarar: string[] = [];

  for (const ruta of [...archivos(APP), ...archivos(LIB)]) {
    const fuente = readFileSync(ruta, "utf8");
    const rel = path.relative(RAIZ_WEB, ruta).split(path.sep).join("/");
    for (const m of fuente.matchAll(/\.rpc\(\s*([^,)\s]+)/g)) {
      const arg = m[1]!;
      const linea = fuente.slice(0, m.index).split(String.fromCharCode(10)).length;
      const literal = arg.match(/^["'`]([a-z_0-9]+)["'`]$/);
      if (literal) {
        resueltas.push({ rpc: literal[1]!, archivo: rel, linea });
        continue;
      }
      const declarados = NOMBRES_VARIABLES[rel];
      if (declarados === undefined) {
        sinDeclarar.push(`${rel}:${linea} — .rpc(${arg}) con nombre variable, sin declarar`);
        continue;
      }
      for (const rpc of declarados) resueltas.push({ rpc, archivo: rel, linea });
    }
  }
  return { resueltas, sinDeclarar };
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
    expect(resueltas.length, "el barrido dejó de encontrar llamadas .rpc(").toBeGreaterThan(60);
    expect(
      resueltas.map((l) => l.rpc),
      "la llamada de nombre variable dejó de resolverse: log_intake_away no está",
    ).toContain("log_intake_away");
  });

  it("toda RPC que la app llama EXISTE en el esquema", async () => {
    const usadas = [...new Set(llamadas().resueltas.map((l) => l.rpc))].sort();
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
    const usadas = [...new Set(llamadas().resueltas.map((l) => l.rpc))].sort();
    expect(usadas.length, "no hay RPC que comprobar").toBeGreaterThan(60);

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
    const usadas = [...new Set(llamadas().resueltas.map((l) => l.rpc))].sort();
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

  let censoAntes: Record<string, number>;
  let hogar: { householdId: string; memberId: string };

  async function tablas(): Promise<string[]> {
    const f = await base.filas<{ t: string }>(
      `select tablename as t from pg_tables where schemaname = 'public' order by 1`,
    );
    return f.map((r) => r.t);
  }

  async function censo(): Promise<Record<string, number>> {
    const ts = await tablas();
    const sql = ts.map((t) => `select '${t}' as t, count(*)::int as n from public.${t}`).join(" union all ");
    const f = await base.filas<{ t: string; n: number }>(sql);
    return Object.fromEntries(f.map((r) => [r.t, r.n]));
  }

  beforeAll(async () => {
    hogar = await crearHogar(base, "00000000-0000-4000-8000-0000000000a1", "Hogar Sintético", "Sintética");
    censoAntes = await censo();
  }, 120_000);

  it("hay filas que perder: el censo no está vacío", async () => {
    // UN CENSO EN CERO SE CONSERVA SOLO. Sin esto, "antes == después" sería
    // cierto por no haber nada, y el test aprobaría una base sin protección.
    const total = Object.values(censoAntes).reduce((a, b) => a + b, 0);
    expect(total, "no se sembró nada: el test no puede probar que nada se perdió").toBeGreaterThan(5);
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
    expect(censoDespues, "el censo cambió: anon consiguió escribir").toEqual(censoAntes);
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
    const usadas = [...new Set(llamadas().resueltas.map((l) => l.rpc))].sort();
    const consulta = `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)
          and has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`;
    const antes = (await vieja.filas<{ proname: string }>(consulta, [usadas])).map((f) => f.proname);
    const despues = (await base.filas<{ proname: string }>(consulta, [usadas])).map((f) => f.proname);
    expect(antes.length, "no se comparó nada").toBeGreaterThan(60);
    expect(despues, "la 0062 le cambió a `authenticated` lo que puede ejecutar").toEqual(antes);
  });

  it("sobre la base en 0061, anon SÍ podía ejecutar RPC de la app", async () => {
    const usadas = [...new Set(llamadas().resueltas.map((l) => l.rpc))].sort();
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
