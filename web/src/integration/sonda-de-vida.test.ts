import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { levantarBase, type Harness } from "./harness";

/**
 * LA SONDA DE VIDA (/api/health), VIGILADA POR LAS DOS PUNTAS.
 *
 * El 2026-09-04 la sonda llevaba días en 503 en producción y ninguna de las
 * 2.441 pruebas lo sabía. La cadena: la sonda leía `households` como `anon`;
 * la política de `households` no lleva cláusula TO, así que anon la evalúa; la
 * política llama a `app.is_household_member`; la 0062 le cerró a anon el
 * esquema `app`. Cada decisión era correcta por separado.
 *
 * Por qué no se vio: el arnés le daba privilegios de tabla sólo a
 * `authenticated`, así que el `select` de anon moría antes de evaluar la
 * política. Eso ya está corregido en `harness.ts`; este archivo es lo que
 * faltaba encima.
 *
 * Se vigila de las dos puntas porque una sola no alcanza:
 *
 *   - LA BASE, con el rol de verdad: la misma consulta que hace la ruta, como
 *     `anon`, sobre la cadena completa. Si la tabla elegida vuelve a tener una
 *     política que anon evalúe, o si anon vuelve a necesitar algo del esquema
 *     `app`, esto revienta ANTES que producción.
 *   - EL HANDLER, con un cliente mínimo: que devuelva 200 con el payload
 *     contado con los dedos, 503 cuando la base no contesta, y que jamás lleve
 *     una fila en la respuesta.
 *
 * Y una guarda sobre el TEXTO de la ruta, para que la tabla no se cambie en
 * silencio por una que anon sí evalúe.
 */

// ---------------------------------------------------------------------------
// Dobles del handler. Se declaran ANTES de importar la ruta: `vi.mock` se iza.
// ---------------------------------------------------------------------------

interface LlamadaRegistrada {
  tabla: string;
  columnas: string;
  opciones: Record<string, unknown> | undefined;
}

const puente = vi.hoisted(() => ({
  /** Qué pidió la ruta, en orden. Es lo que se afirma: no lo que devolvió. */
  llamadas: [] as LlamadaRegistrada[],
  /** Error a devolver por tabla; `undefined` = la base contesta bien. */
  errores: {} as Record<string, { code: string; message: string }>,
  registrados: [] as { evento: string; contexto: Record<string, unknown> }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({
    from: (tabla: string) => ({
      select: async (columnas: string, opciones?: Record<string, unknown>) => {
        puente.llamadas.push({ tabla, columnas, opciones });
        const error = puente.errores[tabla] ?? null;
        // Lo que PostgREST devuelve con `head: true`: sin filas, con o sin error.
        return { data: null, error, count: error ? null : 0 };
      },
    }),
  }),
}));

vi.mock("@/lib/observabilidad", () => ({
  registrarError: (evento: string, contexto: Record<string, unknown> = {}) => {
    puente.registrados.push({ evento, contexto });
  },
}));

const RUTA = path.resolve(__dirname, "../app/api/health/route.ts");
/** La tabla que la ruta consulta. Si cambia, cambian los tests de la base. */
const TABLA = "ingredient_categories";

let base: Harness;

async function comoAnon<T>(h: Harness, fn: () => Promise<T>): Promise<T> {
  // `como()` no limpia el claim al salir; sin esto el "anon" seguiría cargando
  // el uid de una sesión anterior y mediría otra cosa.
  await h.db.query("select set_config('request.jwt.claim.sub', '', false)");
  await h.db.exec("set role anon;");
  try {
    return await fn();
  } finally {
    await h.db.exec("reset role;");
  }
}

/** La consulta de la ruta, tal como la traduce PostgREST con `head: true`. */
const SONDA = (tabla: string) => `select count(*)::int as n from public.${tabla}`;

beforeAll(async () => {
  base = await levantarBase({ conSeeds: false });
  // El handler pregunta `hasSupabaseEnv()` antes de tocar nada. Cada archivo de
  // test corre en su propio fork, así que esto no se filtra a otros archivos.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sonda.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sonda-no-es-una-llave";
}, 180_000);

afterAll(async () => {
  await base?.cerrar();
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

// ---------------------------------------------------------------------------
// La punta de la base
// ---------------------------------------------------------------------------

describe("la sonda contra la base, como anon, sobre la cadena completa", () => {
  it("la ruta consulta la tabla que estos tests vigilan", () => {
    /**
     * LA GUARDA DE TEXTO. Todo lo que sigue afirma cosas sobre `TABLA`; si
     * alguien cambia la ruta a otra tabla, estos tests seguirían verdes
     * mirando la equivocada. Se lee la ruta y se exige que consulte ÉSTA, con
     * `head: true` — que es lo que garantiza que no viaje ni una fila.
     */
    const fuente = readFileSync(RUTA, "utf8");
    expect(fuente).toContain(`.from("${TABLA}")`);
    expect(fuente).toContain("head: true");
    expect(fuente, "la ruta volvió a consultar households").not.toContain('.from("households")');
  });

  it("anon obtiene respuesta, sin error y con CERO filas", async () => {
    const r = await comoAnon(base, () => base.fila<{ n: number }>(SONDA(TABLA)));
    expect(r?.n, "anon vio filas: la RLS dejó de esconder la tabla").toBe(0);
  });

  it("y NO es porque la tabla esté vacía: tiene filas que anon no ve", async () => {
    // Un 0 sobre una tabla vacía no prueba nada. `ingredient_categories` trae
    // sus categorías desde la 0002, así que el 0 de arriba es la RLS
    // escondiendo, no la ausencia de datos.
    const r = await base.fila<{ n: number }>(SONDA(TABLA));
    expect(r?.n, "la tabla está vacía: el 0 de anon no demuestra nada").toBeGreaterThan(5);
  });

  it("la tabla NO tiene ninguna política que anon evalúe", async () => {
    /**
     * LA CONDICIÓN QUE HACE QUE TODO ESTO FUNCIONE, afirmada sobre el catálogo.
     * `roles = {public}` es cómo PostgreSQL guarda una política escrita sin TO.
     * Con una sola así, anon la evaluaría — y si la expresión llama a algo del
     * esquema `app`, estamos de nuevo en 503.
     */
    const politicas = await base.filas<{ policyname: string; roles: string[]; qual: string | null }>(
      `select policyname, roles, qual from pg_policies
        where schemaname = 'public' and tablename = $1 order by 1`,
      [TABLA],
    );
    expect(politicas.length, "la tabla se quedó sin políticas: ¿sigue con RLS?").toBeGreaterThan(0);
    const paraPublic = politicas.filter((p) => p.roles.includes("public"));
    expect(
      paraPublic.map((p) => p.policyname),
      "estas políticas se escribieron sin TO y anon las evalúa",
    ).toEqual([]);
    // Y que ninguna dependa del esquema interno, aunque anon no la evalúe hoy.
    const conApp = politicas.filter((p) => (p.qual ?? "").includes("app."));
    expect(conApp.map((p) => p.policyname), "una política de la sonda llama al esquema app").toEqual([]);
  });

  it("la tabla tiene RLS encendida", async () => {
    const r = await base.fila<{ rls: boolean }>(
      `select relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1`,
      [TABLA],
    );
    expect(r?.rls, "la tabla de la sonda perdió la RLS: anon vería sus filas").toBe(true);
  });

  it("anon NO necesita el esquema `app` ni ninguna SECURITY DEFINER", async () => {
    /**
     * Las dos cosas que la 0062 cerró, afirmadas junto con la sonda: que anon
     * siga sin `usage` sobre `app` y sin EXECUTE sobre ninguna SECDEF, y que
     * AUN ASÍ la sonda conteste. Si mañana alguien "arregla" la sonda
     * devolviéndole a anon alguna de las dos, este test lo dice.
     */
    const r = await base.fila<{ usa: boolean; secdef: number }>(
      `select has_schema_privilege('anon', 'app', 'usage') as usa,
              (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where p.prosecdef and n.nspname in ('public', 'app')
                  and has_function_privilege('anon', p.oid, 'execute')) as secdef`,
    );
    expect(r?.usa, "anon recuperó el usage sobre app").toBe(false);
    expect(r?.secdef, "anon recuperó EXECUTE sobre alguna SECURITY DEFINER").toBe(0);
    const n = await comoAnon(base, () => base.fila<{ n: number }>(SONDA(TABLA)));
    expect(n?.n).toBe(0);
  });

  it("CONTROL: la misma sonda sobre `households` SÍ revienta para anon", async () => {
    /**
     * Sin esto, los tests de arriba pasarían igual con un arnés que no evalúe
     * políticas para anon (que es justo el defecto que tenía). Se exige que la
     * base distinga las dos tablas: la elegida contesta, la vieja revienta.
     */
    let mensaje = "";
    await comoAnon(base, async () => {
      try {
        await base.fila(SONDA("households"));
      } catch (e) {
        mensaje = String((e as Error).message ?? e);
      }
    });
    expect(mensaje, "households dejó de reventar para anon: ¿se aplicó una 0063?").toContain(
      "permission denied",
    );
  });
});

describe("la sonda también funcionaba ANTES de la 0062 (no depende de ella)", () => {
  let vieja: Harness;

  beforeAll(async () => {
    vieja = await levantarBase({ hasta: "0061", conSeeds: false });
  }, 180_000);

  afterAll(async () => {
    await vieja?.cerrar();
  });

  it("sobre la cadena en 0061, anon también obtiene 0 filas sin error", async () => {
    // La tabla nueva no se eligió para esquivar la 0062: sirve igual con anon
    // abierto. Eso es lo que la vuelve una sonda y no un parche.
    const r = await comoAnon(vieja, () => vieja.fila<{ n: number }>(SONDA(TABLA)));
    expect(r?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// La punta del handler
// ---------------------------------------------------------------------------

describe("GET /api/health, el handler de verdad", () => {
  async function GET() {
    puente.llamadas.length = 0;
    puente.registrados.length = 0;
    const mod = await import("@/app/api/health/route");
    return mod.GET();
  }

  it("con la base contestando: 200 y exactamente { ok, version, schema }", async () => {
    puente.errores = {};
    const res = await GET();
    expect(res.status).toBe(200);
    const cuerpo = (await res.json()) as Record<string, unknown>;
    expect(cuerpo.ok).toBe(true);
    // CONTADO CON LOS DEDOS: ni una clave más. Una fila, un conteo o un mensaje
    // de error acá es reconocimiento gratis para quien tantea el sitio.
    expect(Object.keys(cuerpo).sort()).toEqual(["ok", "schema", "version"]);
    expect(puente.registrados, "no había nada que registrar").toEqual([]);
  });

  it("pide la tabla vigilada, con `head: true` y sin traer filas", async () => {
    puente.errores = {};
    await GET();
    expect(puente.llamadas).toHaveLength(1);
    const [l] = puente.llamadas;
    expect(l?.tabla).toBe(TABLA);
    expect(l?.opciones?.head, "la sonda dejó de pedir head: true — viajarían filas").toBe(true);
  });

  it("con la base fallando: 503, sin el mensaje del error en la respuesta", async () => {
    puente.errores = { [TABLA]: { code: "42501", message: "permission denied for function x" } };
    const res = await GET();
    expect(res.status).toBe(503);
    const cuerpo = (await res.json()) as Record<string, unknown>;
    expect(cuerpo.ok).toBe(false);
    expect(Object.keys(cuerpo).sort()).toEqual(["ok", "schema", "version"]);
    const texto = JSON.stringify(cuerpo);
    expect(texto, "el mensaje de la base se filtró a la respuesta").not.toContain("permission");
    // El motivo va al log del servidor, con el código y sin el mensaje.
    expect(puente.registrados.map((r) => r.evento)).toEqual(["health.base_no_responde"]);
    expect(puente.registrados[0]?.contexto.codigo).toBe("42501");
  });

  it("version y schema salen de APP_VERSION y SCHEMA_VERSION, y son null si faltan", async () => {
    // UNKNOWN != ZERO: sin las variables, `null`, no un "0.0.0" inventado.
    puente.errores = {};
    delete process.env.APP_VERSION;
    delete process.env.SCHEMA_VERSION;
    let cuerpo = (await (await GET()).json()) as Record<string, unknown>;
    expect(cuerpo.version).toBeNull();
    expect(cuerpo.schema).toBeNull();

    process.env.APP_VERSION = "1.2.3";
    process.env.SCHEMA_VERSION = "0062";
    cuerpo = (await (await GET()).json()) as Record<string, unknown>;
    expect(cuerpo.version).toBe("1.2.3");
    expect(cuerpo.schema).toBe("0062");
    delete process.env.APP_VERSION;
    delete process.env.SCHEMA_VERSION;
  });
});
