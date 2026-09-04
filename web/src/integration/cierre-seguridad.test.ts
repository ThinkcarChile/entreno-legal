import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * CIERRE DE SEGURIDAD v1 (§48) — la puerta de `anon` y el oráculo de existencia.
 *
 * Dos preguntas, y las dos se contestan contra un Postgres de verdad, no contra
 * la lectura de un archivo:
 *
 *  (a) ¿Puede `anon` —el rol de quien todavía no inició sesión— ejecutar alguna
 *      SECURITY DEFINER de `public`? La respuesta tiene que ser NO, salvo por
 *      una allowlist explícita con su razón escrita.
 *
 *  (b) ¿Esa allowlist dice la verdad? No se declara a mano: se DERIVA del
 *      fuente, igual que `gate-schema-parity.test.ts` deriva las tablas y los
 *      RPC que la app usa. Se recorren las rutas de `web/src/app`, se separan
 *      las que renderizan sin sesión de las que redirigen a /login, y se sigue
 *      el árbol de imports de las primeras buscando `.rpc(`. Lo que salga de
 *      ahí es lo que anon tiene derecho a ejecutar. Hoy sale vacío.
 *
 *  (c) ¿Un id inexistente y un id de otro hogar se responden IGUAL? Cinco RPC
 *      de muestra. `gate-security.test.ts` ya vigila §38 para tres funciones
 *      (`resolve_lot_token`, `use_lot`, `advance_procurement_order`); doce más
 *      se le habían escapado y la 0062 las desempató.
 *
 * POR QUÉ LA MIGRACIÓN SE APLICA ACÁ Y NO EN EL ARNÉS: la 0062 se escribió en
 * paralelo con otra migración y el arnés lo engancha el lead, en serie, después.
 * Mientras tanto este archivo la aplica sobre la cadena completa, que es
 * exactamente el estado en que va a correr.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const SRC = path.resolve(__dirname, "..");
const APP = path.join(SRC, "app");
const MIGRACION = path.join(RAIZ, "supabase", "migrations", "0062_cierre_seguridad.sql");

const USER_A = "00000000-0000-0000-0000-0000000c1e01";
const USER_B = "00000000-0000-0000-0000-0000000c1e02";
/** Un uuid que no es de nadie. Ningún id real de los tests puede coincidir. */
const FANTASMA = "00000000-0000-0000-0000-0000000fa11a";

// ---------------------------------------------------------------------------
// (b) La allowlist, derivada del fuente
// ---------------------------------------------------------------------------

/**
 * Las entradas de ruta que Next renderiza SIN sesión, declaradas a mano y con
 * su razón. No es la allowlist: es la lista de puertas por las que se entra sin
 * llave. El test comprueba que no aparezca ninguna otra — una ruta nueva sin
 * gate obliga a decidir a mano si de verdad va abierta.
 */
const RUTAS_SIN_SESION: Record<string, string> = {
  "layout.tsx": "el armazón del documento: no lee datos, solo pinta <html> y registra el service worker",
  "login/page.tsx": "es la pantalla de entrar; sin ella nadie puede iniciar sesión",
  "api/health/route.ts":
    "la sonda de vida (§51): un monitor no tiene sesión. Devuelve tres campos y " +
    "ninguno viene de la base — ver el porqué en el propio archivo",
};

/** Archivos que Next usa como entrada de una ruta. */
const ES_ENTRADA = /^(page|route|layout|template|default)\.tsx?$/;

function archivos(raiz: string, filtro: (n: string) => boolean): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(raiz)) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) out.push(...archivos(ruta, filtro));
    else if (filtro(nombre)) out.push(ruta);
  }
  return out;
}

const rel = (p: string) => path.relative(APP, p).split(path.sep).join("/");

/**
 * ¿Esta entrada exige sesión antes de tocar nada?
 *
 * Las páginas lo hacen con `auth.getUser()` + `redirect("/login…")`; los route
 * handlers, respondiendo 401. Las dos formas cuentan; cualquier otra tiene que
 * declararse arriba con su razón, porque si no nadie sabría que existe.
 */
function exigeSesion(fuente: string): boolean {
  const mira = /auth\.getUser\(\)/.test(fuente);
  const echa = /redirect\(\s*[`"']\/login/.test(fuente);
  const cuatroCeroUno = /status:\s*401/.test(fuente);
  return mira && (echa || cuatroCeroUno);
}

/** Resuelve un import local (`@/…` o `./…`) al archivo real; `null` si es de node_modules. */
function resolverImport(desde: string, especificador: string): string | null {
  let base: string;
  if (especificador.startsWith("@/")) base = path.join(SRC, especificador.slice(2));
  else if (especificador.startsWith(".")) base = path.resolve(path.dirname(desde), especificador);
  else return null; // next, react, zod, @supabase/… : no son nuestros
  for (const candidato of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    try {
      if (statSync(candidato).isFile()) return candidato;
    } catch {
      /* siguiente candidato */
    }
  }
  return null;
}

/**
 * Todos los `.rpc("…")` alcanzables desde estas entradas, siguiendo los imports.
 * Devuelve tambien los archivos visitados: sin eso, un error en `resolverImport`
 * daria un conjunto vacio y los tests de arriba pasarian diciendo "no hay nada
 * abierto" cuando lo cierto seria "no supe mirar".
 */
function rpcsAlcanzables(entradas: string[]): {
  rpcs: Map<string, string>;
  vistos: Set<string>;
} {
  const vistos = new Set<string>();
  const rpcs = new Map<string, string>();
  const cola = [...entradas];
  while (cola.length > 0) {
    const archivo = cola.pop()!;
    if (vistos.has(archivo)) continue;
    vistos.add(archivo);
    const fuente = readFileSync(archivo, "utf8");
    for (const m of fuente.matchAll(/\.rpc\(\s*"([a-z_0-9]+)"/g)) {
      rpcs.set(m[1]!, path.relative(SRC, archivo).split(path.sep).join("/"));
    }
    for (const m of fuente.matchAll(/from\s+"([^"]+)"/g)) {
      const destino = resolverImport(archivo, m[1]!);
      if (destino !== null) cola.push(destino);
    }
  }
  return { rpcs, vistos };
}

/**
 * La allowlist tal como la declara la migración. Un solo dueño por dato: la
 * 0062 es quien decide, y el test la lee en vez de repetirla.
 */
function allowlistDeLaMigracion(): string[] {
  const sql = readFileSync(MIGRACION, "utf8");
  const marca = sql.indexOf("ALLOWLIST-SIN-SESION");
  expect(marca, "la 0062 perdió la marca ALLOWLIST-SIN-SESION").toBeGreaterThan(-1);
  const declaracion = /v_permitidas\s+text\[\]\s*:=\s*array\[([^\]]*)\]/.exec(sql.slice(marca));
  expect(declaracion, "la 0062 no declara v_permitidas después de la marca").not.toBeNull();
  return [...declaracion![1]!.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]!);
}

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

let h: Harness;
let A: { householdId: string; memberId: string };
let B: { householdId: string; memberId: string };
let eventoA: string;
let participanteA: string;
let listaA: string;
let versionA: string;

beforeAll(async () => {
  // Sin seeds: acá no se prueba ningún dato de demo, se prueba el schema.
  h = await levantarBase({ conSeeds: false });
  // LA MIGRACIÓN DE ESTE ENCARGO, encima de la cadena completa (ver cabecera).
  await h.db.exec(readFileSync(MIGRACION, "utf8"));

  A = await crearHogar(h, USER_A, "Hogar Cierre A", "Ana");
  B = await crearHogar(h, USER_B, "Hogar Cierre B", "Bruno");
  void B;

  await h.comoAdmin(async () => {
    eventoA = (await h.fila<{ id: string }>(
      `insert into public.nutrition_events
         (household_id, event_date, event_type, meal_type, title, status)
       values ($1, current_date, 'BARBECUE', 'LUNCH', 'Asado de A', 'PLANNED')
       returning id`,
      [A.householdId],
    ))!.id;
    participanteA = (await h.fila<{ id: string }>(
      `insert into public.event_participants (event_id, participant_type, member_id)
       values ($1, 'HOUSEHOLD_MEMBER', $2) returning id`,
      [eventoA, A.memberId],
    ))!.id;
  });

  await h.como(USER_A, async () => {
    const plan = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, (date_trunc('week', current_date))::date)",
      [A.householdId],
    ))!.ensure_weekly_plan;
    listaA = (await h.fila<{ id: string }>(
      `insert into public.shopping_lists (household_id, plan_id, status)
       values ($1, $2, 'ACTIVE') returning id`,
      [A.householdId, plan],
    ))!.id;
    versionA = (await h.fila<{ create_meal_template: string }>(
      "select public.create_meal_template($1, 'Receta privada de A', 'MEAL', '{LUNCH}', 4)",
      [A.householdId],
    ))!.create_meal_template;
  });
}, 180_000);

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------
// (a) anon no ejecuta nada
// ---------------------------------------------------------------------------

describe("§48(a) — `anon` no ejecuta ninguna SECURITY DEFINER", () => {
  it("en `public`, las únicas ejecutables por anon son las de la allowlist", async () => {
    const abiertas = await h.filas<{ nombre: string }>(
      `select p.proname as nombre
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname = 'public'
          and has_function_privilege('anon', p.oid, 'EXECUTE')
        order by 1`,
    );
    expect([...new Set(abiertas.map((f) => f.nombre))].sort()).toEqual(
      allowlistDeLaMigracion().sort(),
    );
  });

  it("en `app` no queda ninguna, y anon tampoco puede entrar al esquema", async () => {
    const abiertas = await h.filas<{ nombre: string }>(
      `select p.proname as nombre
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname = 'app'
          and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    );
    expect(abiertas.map((f) => f.nombre)).toEqual([]);
    // El USAGE revocado es lo que cierra las funciones que se escriban MAÑANA:
    // toda función nueva nace con EXECUTE para PUBLIC.
    const usa = await h.fila<{ ok: boolean }>(
      "select has_schema_privilege('anon', 'app', 'USAGE') as ok",
    );
    expect(usa!.ok).toBe(false);
  });

  it("`authenticated` conserva lo que tenía: cerrar anon no cerró la app", async () => {
    // Si esto se cayera a cero, el test de arriba pasaría igual y la familia se
    // quedaría sin app. Un cerrojo que cierra de más también es un defecto.
    const n = await h.fila<{ n: number }>(
      `select count(*)::int as n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname = 'public'
          and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
    );
    expect(n!.n).toBeGreaterThan(100);
    // Y la que la 0060 cerró a mano sigue cerrada: la 0062 re-otorga lo que
    // había, no lo que le parece.
    const purge = await h.fila<{ ok: boolean }>(
      "select has_function_privilege('authenticated', 'public.purge_assistant_conversations()', 'EXECUTE') as ok",
    );
    expect(purge!.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) la allowlist == lo que la app llama sin sesión
// ---------------------------------------------------------------------------

describe("§48(b) — la allowlist sale del fuente, no de la buena voluntad", () => {
  it("toda ruta de la app exige sesión, salvo las declaradas acá con su razón", () => {
    const sinGate: string[] = [];
    for (const ruta of archivos(APP, (n) => ES_ENTRADA.test(n) && !/\.test\./.test(n))) {
      if (exigeSesion(readFileSync(ruta, "utf8"))) continue;
      sinGate.push(rel(ruta));
    }
    // Si aparece una ruta nueva sin gate hay que MIRARLA, no agregarla de oficio:
    // puede ser correcta (una portada pública) o el agujero del sprint.
    expect(sinGate.sort()).toEqual(Object.keys(RUTAS_SIN_SESION).sort());
  });

  it("lo alcanzable desde esas rutas es exactamente la allowlist de la 0062", () => {
    const entradas = Object.keys(RUTAS_SIN_SESION).map((r) => path.join(APP, r));
    const { rpcs: derivada } = rpcsAlcanzables(entradas);
    const declarada = allowlistDeLaMigracion();
    // El mensaje dice DÓNDE, no solo qué: "sobra accept_invitation" manda a
    // buscar; "accept_invitation — usada en app/invite/[token]/actions.ts" ya
    // es el diagnóstico.
    const detalle = [...derivada.entries()].map(([f, a]) => `${f} — usada en ${a}`).sort();
    expect(detalle).toEqual(
      declarada.map((f) => `${f} — usada en ${derivada.get(f) ?? "(no aparece en el fuente)"}`).sort(),
    );
  });

  it("el recorrido de imports SÍ encuentra RPC (no es un verde de lista vacía)", () => {
    // Sin esto, un bug en `resolverImport` haría que todo saliera vacío y los
    // dos tests de arriba pasarían diciendo "no hay nada abierto". Se comprueba
    // contra una ruta que SÍ llama RPC a través de dos saltos de import, y se
    // exige que el recorrido haya usado LAS DOS formas de import del repo: la
    // relativa (`./actions`) y la del alias (`@/lib/supabase/server`). Romper
    // una sola de las dos tiene que verse acá.
    const { rpcs, vistos } = rpcsAlcanzables([path.join(APP, "invite/[token]/page.tsx")]);
    expect([...rpcs.keys()]).toContain("accept_invitation");
    const relativos = [...vistos].map((v) => path.relative(SRC, v).split(path.sep).join("/"));
    expect(relativos).toContain("app/invite/[token]/actions.ts");
    expect(relativos).toContain("lib/supabase/server.ts");
  });
});

// ---------------------------------------------------------------------------
// (c) sin oráculo: existir y no existir se responden igual
// ---------------------------------------------------------------------------

/** Lo que la base le contesta a B: el mensaje del error, o `OK` si no hubo. */
async function respuesta(sql: string, params: unknown[]): Promise<string> {
  return h
    .como(USER_B, async () => {
      await h.db.query(sql, params);
      return "OK — no lanzó";
    })
    .catch((e: Error) => e.message);
}

/**
 * HUECO DECLARADO, NO TAPADO.
 *
 * La 0062 redefine DOCE funciones para cerrar el mismo oráculo. Acá se prueba la
 * conducta de SEIS: cinco por la tabla de abajo más `apply_clinical_shopping_delta`.
 * Las otras seis —`reconcile_purchase` (finanzas), `set_supplier_product_price`
 * (proveedores), `assistant_usage_settle` (asistente),
 * `save_event_estimate_revision`, `record_event_guest_observation` y
 * `app.event_actual_gate`— NO tienen prueba de conducta.
 *
 * Lo que SÍ está verificado de las doce, leyendo el SQL una por una: todas usan
 * la misma forma `if <fila> is null or not <permiso> then` — una sola rama para
 * "no existe" y para "no es tuyo", que es la propiedad que cierra el oráculo.
 * Dos de ellas (`assistant_usage_settle` y `apply_clinical_shopping_delta`) usan
 * un mensaje propio del dominio en vez del genérico "no autorizado", y eso está
 * bien: lo que importa es que las dos respuestas sean IGUALES, no que el texto
 * sea el mismo en todo el repo.
 *
 * Por qué el hueco sigue abierto: sembrar una compra, un producto de proveedor y
 * una traza de asistente en esta base —que se levanta SIN seeds— exige crear
 * antes categoría, alimento, proveedor y hogar con permiso financiero. Se
 * intentó y el andamiaje resultó más grande que lo que prueba. Queda escrito acá
 * en vez de en la cabeza de alguien: cuando este archivo gane un fixture de
 * hogar completo, estas seis entran a la tabla de abajo sin más trabajo.
 */
describe("§48(c) — cinco RPC: un id ajeno y un id inventado dicen lo mismo", () => {
  const casos: [string, string, (id: string) => [string, unknown[]]][] = [
    [
      "set_event_status",
      "evento",
      (id) => ["select public.set_event_status($1, 'CONFIRMED')", [id]],
    ],
    [
      "event_menu_blocks",
      "evento",
      (id) => ["select * from public.event_menu_blocks($1)", [id]],
    ],
    [
      "record_event_attendance",
      "participante",
      (id) => ["select public.record_event_attendance($1, 'CONFIRMED')", [id]],
    ],
    [
      "generate_shopping_revision",
      "lista",
      (id) => [
        "select public.generate_shopping_revision($1, 'firma', 'v', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)",
        [id],
      ],
    ],
    [
      "create_draft_from_version",
      "version",
      (id) => ["select public.create_draft_from_version($1)", [id]],
    ],
  ];

  const idReal = (que: string): string =>
    que === "evento"
      ? eventoA
      : que === "participante"
        ? participanteA
        : que === "lista"
          ? listaA
          : versionA;

  for (const [nombre, que, arma] of casos) {
    it(`${nombre}: el ${que} de A y uno inventado dan la MISMA respuesta`, async () => {
      const [sqlReal, pReal] = arma(idReal(que));
      const [sqlFalso, pFalso] = arma(FANTASMA);
      const ajeno = await respuesta(sqlReal, pReal);
      const inventado = await respuesta(sqlFalso, pFalso);

      // ERROR != VACÍO: si alguna de las dos NO lanzara, comparar mensajes daría
      // verde comparando dos "OK" y el hogar B habría escrito en la casa de A.
      expect(ajeno, `${nombre} dejó pasar el ${que} de otro hogar`).not.toContain("OK — no lanzó");
      expect(inventado, `${nombre} dejó pasar un id inventado`).not.toContain("OK — no lanzó");
      expect(inventado).toBe(ajeno);
    });
  }

  it("apply_clinical_shopping_delta no devuelve el estado de una revisión ajena", async () => {
    // La única de las doce que no lanzaba nada: DEVOLVÍA el `status` de una
    // revisión clínica de otro hogar ya resuelta. Un dato clínico entregado a
    // quien adivine un uuid, sin error de por medio.
    const revisionA = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.clinical_impact_reviews
           (household_id, member_id, status, trigger_kind)
         values ($1, $2, 'DISMISSED', 'RESTRICTION_ADDED') returning id`,
        [A.householdId, A.memberId],
      ),
    );
    const ajena = await respuesta(
      "select public.apply_clinical_shopping_delta($1, '[]'::jsonb)",
      [revisionA!.id],
    );
    const inventada = await respuesta(
      "select public.apply_clinical_shopping_delta($1, '[]'::jsonb)",
      [FANTASMA],
    );
    expect(ajena).not.toContain("OK — no lanzó");
    expect(inventada).toBe(ajena);
  });
});
