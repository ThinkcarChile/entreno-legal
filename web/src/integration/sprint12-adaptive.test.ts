import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Sprint 12 — la migración 0040 contra un PostgreSQL de verdad.
 *
 * POR QUÉ ESTE ARCHIVO LEVANTA SU PROPIA BASE Y NO USA `levantarBase`:
 * la 0040 todavía no está en la lista `MIGRACIONES` de `harness.ts`, y ese
 * archivo lo comparten varios agentes trabajando en el mismo árbol. Copiar la
 * lista acá es feo, pero la alternativa —esperar a que alguien agregue la
 * línea— es entregar una migración sin correr, y un motor sin test no está
 * hecho. Cuando la 0040 entre a `harness.ts`, este bloque se borra y el archivo
 * pasa a usar `levantarBase` como todos los demás.
 *
 * Se levanta SIN seeds: nada de lo que se prueba acá necesita el catálogo, y
 * saltárselo baja el arranque de segundos a milisegundos.
 */

const ROOT = path.resolve(__dirname, "../../..");

const MIGRACIONES = [
  "supabase/migrations/0001_family.sql",
  "supabase/migrations/0002_catalog.sql",
  "supabase/migrations/0003_recipes.sql",
  "supabase/migrations/0004_publish_consistency_guard.sql",
  "supabase/migrations/0005_profiles_and_portions.sql",
  "supabase/migrations/0006_component_roles.sql",
  "supabase/migrations/0007_weekly_planning.sql",
  "supabase/migrations/0008_participants_and_serving_lifecycle.sql",
  "supabase/migrations/0009_shopping.sql",
  "supabase/migrations/0010_hardening_sprint6.sql",
  "supabase/migrations/0011_inventory.sql",
  "supabase/migrations/0012_consumption_shortfall.sql",
  "supabase/migrations/0013_stock_intelligence.sql",
  "supabase/migrations/0014_procurement.sql",
  "supabase/migrations/0015_batch_prep.sql",
  "supabase/migrations/0016_freezing_rules.sql",
  "supabase/migrations/0017_random_without_pgcrypto.sql",
  "supabase/migrations/0018_substitution_choices.sql",
  "supabase/migrations/0019_gate_fixes_ledger.sql",
  "supabase/migrations/0020_gate_scope_and_basis.sql",
  "supabase/migrations/0021_gate_netting_basis.sql",
  "supabase/migrations/0022_consume_product_identity.sql",
  "supabase/migrations/0023_confirm_consume_serialization.sql",
  "supabase/migrations/0024_demo_family_function.sql",
  "supabase/migrations/0025_unknown_never_normal.sql",
  "supabase/migrations/0026_health_documents.sql",
  "supabase/migrations/0027_clinical_rules.sql",
  "supabase/migrations/0028_fix_encoding.sql",
  "supabase/migrations/0029_nutrition_source.sql",
  "supabase/migrations/0030_clinical_shopping_impact.sql",
  "supabase/migrations/0031_yield_factor_bounds.sql",
  "supabase/migrations/0032_pressure_cooker_capability.sql",
  "supabase/migrations/0033_cerrar_salto_entre_hogares.sql",
  "supabase/migrations/0034_storage_medico_lectura_y_borrado.sql",
  "supabase/migrations/0035_porcion_sin_evaluar.sql",
  "supabase/migrations/0037_invitacion_no_cruza_hogares.sql",
  "supabase/migrations/0036_foodlog_plan_vs_reality.sql",
  "supabase/migrations/0038_foodlog_intake.sql",
  // La pieza de este archivo.
  "supabase/migrations/0040_adaptive_reviews.sql",
];

const ENTORNO_SUPABASE = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public
    grant select, insert, update, delete on tables to authenticated;
`;

/**
 * ERROR != VACÍO: si falta una migración, esto revienta con nombre y apellido.
 * Un test que se salta la migración que está probando da un verde que miente.
 */
function leerMigracion(relativo: string): string {
  const absoluto = path.join(ROOT, relativo);
  try {
    return readFileSync(absoluto, "utf8");
  } catch {
    const numero = path.basename(relativo).slice(0, 4);
    const carpeta = path.dirname(absoluto);
    const candidatos = readdirSync(carpeta).filter(
      (f) => f.startsWith(`${numero}_`) && f.endsWith(".sql"),
    );
    if (candidatos.length === 1) return readFileSync(path.join(carpeta, candidatos[0]!), "utf8");
    throw new Error(`Falta la migración ${relativo} (candidatos: ${candidatos.join(", ") || "ninguno"})`);
  }
}

let db: PGlite;

async function como<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec("set role authenticated;");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
  try {
    return await fn();
  } finally {
    await db.exec("reset role;");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

async function comoAdmin<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("reset role;");
  await db.query("select set_config('request.jwt.claim.sub', '', false)");
  return fn();
}

async function filas<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function fila<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  return (await filas<T>(sql, params))[0] ?? null;
}

interface Hogar {
  userId: string;
  householdId: string;
  memberId: string;
}

async function crearHogar(userId: string, hogar: string, nombre: string): Promise<Hogar> {
  await comoAdmin(async () => {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `${nombre.toLowerCase()}@test.dev`,
    ]);
  });
  return como(userId, async () => {
    const creado = await fila<{ create_household: string }>("select public.create_household($1, $2)", [
      hogar,
      nombre,
    ]);
    const householdId = creado!.create_household;
    const miembro = await fila<{ id: string }>(
      "select id from public.household_members where household_id = $1 and user_id = $2",
      [householdId, userId],
    );
    return { userId, householdId, memberId: miembro!.id };
  });
}

/** El día civil del hogar, que es el único reloj que la base acepta. */
async function hoyDe(householdId: string): Promise<string> {
  const r = await comoAdmin(() =>
    fila<{ d: string }>("select app.household_today($1)::text as d", [householdId]),
  );
  return r!.d;
}

function masDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

const PAYLOAD_BASE = {
  plan_snapshot: { trackingMode: "FULL", dailyTargets: { PROTEIN_G: 100 } },
  intake_snapshot: { window: "D3", coverage: 1, actual: { protein_g: 70 } },
  params: { engine: "adaptive-nutrition/1.0.0", maxDecreaseRatio: 0.9, maxValidityDays: 3 },
  reasons: [{ code: "DEFICIT_D3" }],
  missing_data: [],
};

/** Propuesta estándar: subir la proteína. Los números salen de acá, no del caller. */
const AJUSTE_PROTEINA = {
  goal_type: "PROTEIN_G",
  scope: "DAILY",
  minimum: 90,
  preferred: 110,
  maximum: 130,
};

async function proponer(
  h: Hogar,
  opciones: {
    fecha?: string;
    ventana?: string;
    version?: string;
    veredicto?: string;
    ajustes?: unknown[];
  } = {},
): Promise<string> {
  const fecha = opciones.fecha ?? (await hoyDe(h.householdId));
  const r = await como(h.userId, () =>
    fila<{ create_adaptive_review: string }>(
      "select public.create_adaptive_review($1, $2::date, $3::public.adaptive_rolling_window, $4, $5::public.adaptive_verdict, $6::jsonb)",
      [
        h.memberId,
        fecha,
        opciones.ventana ?? "D3",
        opciones.version ?? "adaptive-nutrition/1.0.0",
        opciones.veredicto ?? "RECOMMENDED_ADJUSTMENT",
        JSON.stringify({ ...PAYLOAD_BASE, adjustments: opciones.ajustes ?? [AJUSTE_PROTEINA] }),
      ],
    ),
  );
  return r!.create_adaptive_review;
}

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
  await db.exec("create extension if not exists pg_trgm; create extension if not exists pgcrypto;");
  await db.exec(ENTORNO_SUPABASE);
  for (const archivo of MIGRACIONES) await db.exec(leerMigracion(archivo));
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("0040 — el motor propone, la base guarda una PROPUESTA", () => {
  it("la revisión nace PENDING y con sus reglas congeladas", async () => {
    const h = await crearHogar(
      "11111111-1111-4111-8111-111111111111",
      "Hogar propuesta",
      "Ana",
    );
    const reviewId = await proponer(h);

    const r = await comoAdmin(() =>
      fila<{
        status: string;
        engine_version: string;
        params: Record<string, unknown>;
        clinical_capped: boolean;
        resolved_at: string | null;
        dedupe_key: string;
      }>("select * from public.adaptive_nutrition_reviews where id = $1", [reviewId]),
    );

    expect(r!.status).toBe("PENDING");
    expect(r!.engine_version).toBe("adaptive-nutrition/1.0.0");
    // Congelado: los topes con los que se calculó viajan EN la fila.
    expect(r!.params).toMatchObject({ maxValidityDays: 3 });
    expect(r!.clinical_capped).toBe(false);
    expect(r!.resolved_at).toBeNull();
    expect(r!.dedupe_key).toContain("ADAPT:");

    // Nace sin ningún objetivo temporal: proponer no es aplicar.
    const objetivos = await comoAdmin(() =>
      filas("select 1 from public.member_temporary_targets where member_id = $1", [h.memberId]),
    );
    expect(objetivos).toHaveLength(0);
  });

  it("es idempotente: la misma persona, día, ventana y versión dan la MISMA revisión", async () => {
    const h = await crearHogar(
      "11111111-1111-4111-8111-111111111112",
      "Hogar idempotente",
      "Bruno",
    );
    const a = await proponer(h);
    const b = await proponer(h);
    expect(b).toBe(a);

    const n = await comoAdmin(() =>
      filas("select 1 from public.adaptive_nutrition_reviews where member_id = $1", [h.memberId]),
    );
    expect(n).toHaveLength(1);
  });

  it("el motor NO ESCRIBE: la escritura directa está revocada en las tres tablas", async () => {
    const h = await crearHogar(
      "11111111-1111-4111-8111-111111111113",
      "Hogar sin escritura",
      "Carla",
    );
    const hoy = await hoyDe(h.householdId);

    await como(h.userId, async () => {
      await expect(
        db.query(
          `insert into public.adaptive_nutrition_reviews
             (household_id, member_id, review_date, rolling_window, engine_version, params,
              verdict, plan_snapshot, intake_snapshot, dedupe_key)
           values ($1, $2, $3::date, 'D3', 'a-mano/0.0.0', '{}'::jsonb,
                   'NO_CHANGE', '{}'::jsonb, '{}'::jsonb, 'A_MANO')`,
          [h.householdId, h.memberId, hoy],
        ),
        // CON MATCHER: un `rejects.toThrow()` pelado se pone verde igual si el
        // insert revienta por una columna renombrada o por un NOT NULL, y esto
        // afirma que lo que frena es EL PERMISO REVOCADO (0040:550).
      ).rejects.toThrow(/permission denied .*adaptive_nutrition_reviews/i);

      await expect(
        db.query(
          `insert into public.member_temporary_targets
             (household_id, member_id, goal_type, valid_from, valid_until, provenance,
              approved_by, frozen_params, maximum)
           values ($1, $2, 'PROTEIN_G', $3::date, $3::date, 'ADAPTIVE_ENGINE', $2, '{}'::jsonb, 999)`,
          [h.householdId, h.memberId, hoy],
        ),
      ).rejects.toThrow(/permission denied .*member_temporary_targets/i);
    });
  });
});

describe("0040 — un ajuste sin término rebota", () => {
  it("la tabla no acepta un ajuste temporal sin fecha de término", async () => {
    const h = await crearHogar("22222222-2222-4222-8222-222222222221", "Hogar sin fin", "Dora");
    const hoy = await hoyDe(h.householdId);

    await comoAdmin(async () => {
      await expect(
        db.query(
          `insert into public.member_temporary_targets
             (household_id, member_id, goal_type, valid_from, valid_until, provenance,
              approved_by, frozen_params, maximum)
           values ($1, $2, 'PROTEIN_G', $3::date, null, 'ADAPTIVE_ENGINE', $2, '{}'::jsonb, 130)`,
          [h.householdId, h.memberId, hoy],
        ),
      ).rejects.toThrow(/valid_until|not.null|null value/i);
    });
  });

  it("resolver aceptando un ajuste sin valid_until se niega, y lo dice con nombre", async () => {
    const h = await crearHogar("22222222-2222-4222-8222-222222222222", "Hogar sin fin 2", "Elena");
    const reviewId = await proponer(h);
    const hoy = await hoyDe(h.householdId);

    await como(h.userId, async () => {
      await expect(
        db.query(
          "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
          [
            reviewId,
            JSON.stringify([{ goal_type: "PROTEIN_G", scope: "DAILY", valid_from: hoy }]),
          ],
        ),
      ).rejects.toThrow(/sin fecha de t/i);
    });

    // Y no dejó nada a medio aplicar: la revisión sigue PENDING.
    const r = await comoAdmin(() =>
      fila<{ status: string }>("select status from public.adaptive_nutrition_reviews where id = $1", [
        reviewId,
      ]),
    );
    expect(r!.status).toBe("PENDING");
    const objetivos = await comoAdmin(() =>
      filas("select 1 from public.member_temporary_targets where member_id = $1", [h.memberId]),
    );
    expect(objetivos).toHaveLength(0);
  });

  it("un término más allá del tope se descarta con su motivo, sin voltear los demás ajustes", async () => {
    const h = await crearHogar("22222222-2222-4222-8222-222222222223", "Hogar largo", "Fabián");
    const reviewId = await proponer(h, {
      ajustes: [AJUSTE_PROTEINA, { goal_type: "FIBER_G", scope: "DAILY", minimum: 25, preferred: 30 }],
    });
    const hoy = await hoyDe(h.householdId);

    const res = await como(h.userId, () =>
      fila<{ resolve_adaptive_review: { applied: unknown[]; discarded: { code: string }[] } }>(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [
          reviewId,
          JSON.stringify([
            // 30 días de "temporal" son un cambio de objetivo pagado en cuotas.
            { goal_type: "PROTEIN_G", scope: "DAILY", valid_from: hoy, valid_until: masDias(hoy, 30) },
            { goal_type: "FIBER_G", scope: "DAILY", valid_from: hoy, valid_until: masDias(hoy, 2) },
          ]),
        ],
      ),
    );

    const r = res!.resolve_adaptive_review;
    expect(r.applied).toHaveLength(1);
    expect(r.discarded).toEqual([
      expect.objectContaining({ goal_type: "PROTEIN_G", code: "EXCEEDS_MAX_VALIDITY_DAYS" }),
    ]);

    const vivos = await comoAdmin(() =>
      filas<{ goal_type: string }>(
        "select goal_type from public.member_temporary_targets where member_id = $1",
        [h.memberId],
      ),
    );
    expect(vivos.map((v) => v.goal_type)).toEqual(["FIBER_G"]);
  });

  it("el tope de vigencia es UNO SOLO y vive en la base", async () => {
    const tope = await comoAdmin(() =>
      fila<{ d: number }>("select public.adaptive_max_validity_days() as d"),
    );
    expect(tope!.d).toBe(3);

    const h = await crearHogar("22222222-2222-4222-8222-222222222224", "Hogar tope", "Gabi");
    const hoy = await hoyDe(h.householdId);
    await comoAdmin(async () => {
      await expect(
        db.query(
          `insert into public.member_temporary_targets
             (household_id, member_id, goal_type, valid_from, valid_until, provenance,
              approved_by, frozen_params, maximum)
           values ($1, $2, 'PROTEIN_G', $3::date, $4::date, 'ADAPTIVE_ENGINE', $2, '{}'::jsonb, 130)`,
          [h.householdId, h.memberId, hoy, masDias(hoy, 4)],
        ),
      ).rejects.toThrow(/tt_is_temporary/i);
    });
  });
});

describe("0040 — una revisión no se aplica dos veces", () => {
  it("el segundo resolve retorna sin efecto y no duplica el ajuste", async () => {
    const h = await crearHogar("33333333-3333-4333-8333-333333333331", "Hogar doble", "Hugo");
    const reviewId = await proponer(h);
    const hoy = await hoyDe(h.householdId);
    const aceptado = JSON.stringify([
      { goal_type: "PROTEIN_G", scope: "DAILY", valid_from: hoy, valid_until: masDias(hoy, 2) },
    ]);

    const primera = await como(h.userId, () =>
      fila<{ resolve_adaptive_review: { applied: unknown[]; already_resolved: boolean } }>(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [reviewId, aceptado],
      ),
    );
    expect(primera!.resolve_adaptive_review.already_resolved).toBe(false);
    expect(primera!.resolve_adaptive_review.applied).toHaveLength(1);

    const segunda = await como(h.userId, () =>
      fila<{ resolve_adaptive_review: { applied: unknown[]; already_resolved: boolean; status: string } }>(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [reviewId, aceptado],
      ),
    );
    expect(segunda!.resolve_adaptive_review.already_resolved).toBe(true);
    expect(segunda!.resolve_adaptive_review.status).toBe("APPLIED");
    expect(segunda!.resolve_adaptive_review.applied).toHaveLength(0);

    const objetivos = await comoAdmin(() =>
      filas("select 1 from public.member_temporary_targets where member_id = $1", [h.memberId]),
    );
    expect(objetivos).toHaveLength(1);
  });

  it("una revisión resuelta es historia: no se reescribe ni se borra", async () => {
    const h = await crearHogar("33333333-3333-4333-8333-333333333332", "Hogar historia", "Ivo");
    const reviewId = await proponer(h);
    await como(h.userId, () =>
      db.query("select public.resolve_adaptive_review($1, 'DISMISSED'::public.impact_review_status)", [
        reviewId,
      ]),
    );

    await comoAdmin(async () => {
      await expect(
        db.query("update public.adaptive_nutrition_reviews set status = 'PENDING' where id = $1", [
          reviewId,
        ]),
      ).rejects.toThrow(/la historia no se reescribe/i);
      await expect(
        db.query("delete from public.adaptive_nutrition_reviews where id = $1", [reviewId]),
      ).rejects.toThrow(/no se borra/i);
      // Ni siquiera estando PENDING se puede cambiar lo propuesto.
      const otra = await proponer(h, { ventana: "D7" });
      await expect(
        db.query("update public.adaptive_nutrition_reviews set adjustments = '[]'::jsonb where id = $1", [
          otra,
        ]),
      ).rejects.toThrow(/no se reescribe/i);
    });
  });

  it("dos ajustes vigentes traslapados no pueden coexistir", async () => {
    const h = await crearHogar("33333333-3333-4333-8333-333333333333", "Hogar traslape", "Javi");
    const hoy = await hoyDe(h.householdId);

    const r1 = await proponer(h, { ventana: "D3" });
    await como(h.userId, () =>
      db.query(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [
          r1,
          JSON.stringify([
            { goal_type: "PROTEIN_G", scope: "DAILY", valid_from: hoy, valid_until: masDias(hoy, 3) },
          ]),
        ],
      ),
    );

    const r2 = await proponer(h, { ventana: "D7" });
    const res = await como(h.userId, () =>
      fila<{ resolve_adaptive_review: { applied: unknown[]; discarded: { code: string }[] } }>(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [
          r2,
          JSON.stringify([
            // Empieza dentro del rango del primero: ese día tendría dos metas.
            { goal_type: "PROTEIN_G", scope: "DAILY", valid_from: masDias(hoy, 2), valid_until: masDias(hoy, 4) },
          ]),
        ],
      ),
    );

    expect(res!.resolve_adaptive_review.applied).toHaveLength(0);
    expect(res!.resolve_adaptive_review.discarded).toEqual([
      expect.objectContaining({ code: "OVERLAPS_ACTIVE_TARGET" }),
    ]);
  });
});

describe("0040 — el vecino no lee ni resuelve lo del hogar de al lado", () => {
  it("no ve la revisión, no ve el ajuste, y resolver le dice que no", async () => {
    const casa = await crearHogar("44444444-4444-4444-8444-444444444441", "Casa A", "Karla");
    const vecino = await crearHogar("44444444-4444-4444-8444-444444444442", "Casa B", "Lalo");

    const reviewId = await proponer(casa);
    const hoy = await hoyDe(casa.householdId);
    await como(casa.userId, () =>
      db.query(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [
          reviewId,
          JSON.stringify([
            { goal_type: "PROTEIN_G", scope: "DAILY", valid_from: hoy, valid_until: masDias(hoy, 1) },
          ]),
        ],
      ),
    );

    // El dueño de casa sí ve lo suyo: si no viera nada, este test pasaría por
    // la razón equivocada.
    const propias = await como(casa.userId, () =>
      filas("select id from public.adaptive_nutrition_reviews"),
    );
    expect(propias).toHaveLength(1);

    await como(vecino.userId, async () => {
      expect(await filas("select id from public.adaptive_nutrition_reviews")).toHaveLength(0);
      expect(await filas("select id from public.member_temporary_targets")).toHaveLength(0);
      expect(await filas("select review_id from public.adaptive_review_clinical_context")).toHaveLength(0);

      await expect(
        db.query("select public.resolve_adaptive_review($1, 'DISMISSED'::public.impact_review_status)", [
          reviewId,
        ]),
      ).rejects.toThrow(/no autorizado/i);

      await expect(
        db.query(
          "select public.create_adaptive_review($1, current_date, 'D3'::public.adaptive_rolling_window, 'x/1.0.0', 'NO_CHANGE'::public.adaptive_verdict, $2::jsonb)",
          [casa.memberId, JSON.stringify(PAYLOAD_BASE)],
        ),
      ).rejects.toThrow(/no autorizado/i);
    });

    // Y no lo resolvió: sigue APPLIED por su dueño, no DISMISSED por el vecino.
    const r = await comoAdmin(() =>
      fila<{ status: string }>("select status from public.adaptive_nutrition_reviews where id = $1", [
        reviewId,
      ]),
    );
    expect(r!.status).toBe("APPLIED");
  });
});

describe("0040 — resolver exige un humano", () => {
  it("sin integrante detrás de la sesión no se resuelve nada", async () => {
    const h = await crearHogar("55555555-5555-4555-8555-555555555551", "Hogar humano", "Marta");
    const reviewId = await proponer(h);

    // Sin sesión: ni siquiera hay quién apruebe. CON MATCHER: sin él, un typo en
    // el nombre de la función o un enum mal escrito daban el mismo verde.
    await como(null, async () => {
      await expect(
        db.query("select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status)", [
          reviewId,
        ]),
      ).rejects.toThrow(/no autorizado/i);
    });

    // Como postgres (sin sesión de usuario) tampoco: un proceso no es una
    // persona. HONESTIDAD SOBRE QUÉ PARED RESPONDE: sin sesión, `auth.uid()` es
    // null y la primera que contesta es `app.can_access_member` con «no
    // autorizado»; la segunda —«una propuesta la aprueba una persona», por
    // `app.current_member_id`— es la que cubre el caso de una sesión que sí
    // pasa la primera y no tiene integrante. Ese segundo camino no se alcanza
    // desde acá, y por eso el matcher exige el mensaje que de verdad sale.
    await comoAdmin(async () => {
      await expect(
        db.query("select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status)", [
          reviewId,
        ]),
      ).rejects.toThrow(/no autorizado/i);
    });

    const r = await comoAdmin(() =>
      fila<{ status: string }>("select status from public.adaptive_nutrition_reviews where id = $1", [
        reviewId,
      ]),
    );
    expect(r!.status).toBe("PENDING");
  });

  it("el ajuste aplicado lleva el sello de quien lo aprobó", async () => {
    const h = await crearHogar("55555555-5555-4555-8555-555555555552", "Hogar sello", "Nico");
    const reviewId = await proponer(h);
    const hoy = await hoyDe(h.householdId);

    await como(h.userId, () =>
      db.query(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [
          reviewId,
          JSON.stringify([
            { goal_type: "PROTEIN_G", scope: "DAILY", valid_from: hoy, valid_until: masDias(hoy, 1) },
          ]),
        ],
      ),
    );

    const t = await comoAdmin(() =>
      fila<{
        approved_by: string;
        provenance: string;
        review_id: string;
        frozen_params: Record<string, unknown>;
        status: string;
      }>("select * from public.member_temporary_targets where member_id = $1", [h.memberId]),
    );
    expect(t!.approved_by).toBe(h.memberId);
    expect(t!.provenance).toBe("ADAPTIVE_ENGINE");
    expect(t!.review_id).toBe(reviewId);
    // Los topes con los que se calculó viajan con el ajuste.
    expect(t!.frozen_params).toMatchObject({ maxValidityDays: 3 });
    expect(t!.status).toBe("ACTIVE");
  });
});

describe("0040 — lo clínico es cota, no sugerencia", () => {
  /** Deja una restricción clínica CONFIRMED y vigente para hoy. */
  async function restringir(
    h: Hogar,
    tipo: "NUTRIENT_MAX" | "NUTRIENT_MIN",
    target: string,
    value: number | null,
    unit: string | null,
  ): Promise<void> {
    await comoAdmin(async () => {
      await db.query(
        `insert into public.member_clinical_restrictions
           (member_id, type, target, value, unit, severity, source, verification_status, valid_from)
         values ($1, $2::public.clinical_restriction_type, $3, $4, $5, 'HARD',
                 'CLINICIAN_ENTERED', 'CONFIRMED', current_date - 1)`,
        [h.memberId, tipo, target, value, unit],
      );
    });
  }

  it("un techo clínico recorta el ajuste y JAMÁS lo ensancha", async () => {
    const h = await crearHogar("66666666-6666-4666-8666-666666666661", "Hogar techo", "Olga");
    await restringir(h, "NUTRIENT_MAX", "protein_g", 100, "g");

    // Se propone maximum 130; el techo dice 100.
    const reviewId = await proponer(h);

    const r = await comoAdmin(() =>
      fila<{ adjustments: { maximum: number; preferred: number }[]; clinical_capped: boolean }>(
        "select adjustments, clinical_capped from public.adaptive_nutrition_reviews where id = $1",
        [reviewId],
      ),
    );
    expect(r!.clinical_capped).toBe(true);
    expect(Number(r!.adjustments[0]!.maximum)).toBe(100);
    // El preferido también bajó: si sólo se recortara el máximo, el INSERT
    // reventaría contra tt_range_ordered y la persona vería un error opaco.
    expect(Number(r!.adjustments[0]!.preferred)).toBe(100);

    const hoy = await hoyDe(h.householdId);
    await como(h.userId, () =>
      db.query(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [
          reviewId,
          JSON.stringify([
            { goal_type: "PROTEIN_G", scope: "DAILY", valid_from: hoy, valid_until: masDias(hoy, 1) },
          ]),
        ],
      ),
    );

    const t = await comoAdmin(() =>
      fila<{ maximum: string }>(
        "select maximum from public.member_temporary_targets where member_id = $1",
        [h.memberId],
      ),
    );
    expect(Number(t!.maximum)).toBe(100);
  });

  it("un techo CONFIRMED sin cifra bloquea el ajuste: least() contra NULL no recorta nada", async () => {
    const h = await crearHogar("66666666-6666-4666-8666-666666666662", "Hogar sin cifra", "Pía");
    // "Hay un límite y no sabemos cuál". UNKNOWN nunca significa NORMAL.
    await restringir(h, "NUTRIENT_MAX", "protein_g", null, "g");

    const reviewId = await proponer(h);
    const r = await comoAdmin(() =>
      fila<{ adjustments: unknown[]; verdict: string; clinical_capped: boolean }>(
        "select adjustments, verdict, clinical_capped from public.adaptive_nutrition_reviews where id = $1",
        [reviewId],
      ),
    );
    expect(r!.adjustments).toHaveLength(0);
    expect(r!.verdict).toBe("REVIEW_REQUIRED");
    expect(r!.clinical_capped).toBe(true);
  });

  it("un piso clínico se compone con greatest: el ajuste no baja bajo el mínimo", async () => {
    const h = await crearHogar("66666666-6666-4666-8666-666666666663", "Hogar piso", "Quena");
    await restringir(h, "NUTRIENT_MIN", "protein_g", 95, "g");

    // Se propone bajar el mínimo a 60; el piso clínico dice 95.
    const reviewId = await proponer(h, {
      ajustes: [{ goal_type: "PROTEIN_G", scope: "DAILY", minimum: 60, preferred: 70, maximum: 90 }],
    });

    const r = await comoAdmin(() =>
      fila<{ adjustments: { minimum: number }[]; verdict: string }>(
        "select adjustments, verdict from public.adaptive_nutrition_reviews where id = $1",
        [reviewId],
      ),
    );
    // El piso (95) quedó sobre el máximo propuesto (90): el ajuste se descarta
    // entero en vez de aplicarse por debajo del mínimo clínico.
    expect(r!.adjustments).toHaveLength(0);
    expect(r!.verdict).toBe("REVIEW_REQUIRED");
  });

  it("el motivo clínico NO se ve en la superficie del hogar, sí con permiso médico", async () => {
    const h = await crearHogar("66666666-6666-4666-8666-666666666664", "Hogar privado", "Rosa");
    await restringir(h, "NUTRIENT_MAX", "protein_g", null, "g");
    const reviewId = await proponer(h);

    // LAS COLUMNAS REALES DE LA TABLA, no las que este test eligió traer. Un
    // `select clinical_capped` seguido de `expect(Object.keys(fila))` es
    // tautológico: pasaría igual con una columna `clinical_nutrient` al lado.
    const columnas = await comoAdmin(() =>
      filas<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'adaptive_nutrition_reviews'
         order by column_name`,
      ),
    );
    expect(columnas.length, "sin columnas la tabla no existe y este test no mira nada").toBeGreaterThan(10);
    const nombres = columnas.map((c) => c.column_name);
    // Ni nutriente, ni cifra, ni severidad, ni ids, ni un contador (que sería
    // la existencia del techo más su cardinalidad con disfraz aritmético).
    const fuga = /clinic|restric|severit|nutrient|diagnos|condit|lab_|medic/i;
    expect(
      nombres.filter((n) => fuga.test(n) && n !== "clinical_capped"),
      "la superficie del hogar ganó una columna que habla de la condición",
    ).toEqual([]);
    // Y la única permitida es una BANDERA: un numeric o un text acá sería la
    // cifra —o la cuenta— escondida detrás de un nombre inocente.
    expect(columnas.find((c) => c.column_name === "clinical_capped")?.data_type).toBe("boolean");

    // La FILA COMPLETA que ve el hogar, con `select *`: nada de elegir columnas.
    const publico = await como(h.userId, () =>
      fila<Record<string, unknown>>(
        "select * from public.adaptive_nutrition_reviews where id = $1",
        [reviewId],
      ),
    );
    // El hogar ve la tabla entera, así que la privacidad tiene que estar en la
    // FORMA de la tabla y no en qué columnas pida el que consulta.
    expect(Object.keys(publico!).sort()).toEqual([...nombres].sort());
    expect(publico!.clinical_capped).toBe(true);

    // Y el contenido de los jsonb tampoco filtra: ni el id de la restricción,
    // ni su severidad, ni el código clínico del descarte. (El NOMBRE del
    // nutriente no sirve como señal acá: `plan_snapshot` lleva los objetivos
    // que la propia persona declaró, y ésos son suyos, no un dato clínico.)
    const restriccion = await comoAdmin(() =>
      fila<{ id: string; severity: string }>(
        "select id, severity from public.member_clinical_restrictions where member_id = $1",
        [h.memberId],
      ),
    );
    const texto = JSON.stringify(publico);
    expect(texto).not.toContain(restriccion!.id);
    expect(texto, "la severidad de la restricción viajó a la tabla del hogar").not.toMatch(
      new RegExp(`"${restriccion!.severity}"`),
    );
    for (const codigo of [
      "CLINICAL_LIMIT_UNUSABLE",
      "CLINICAL_CEILING_BLOCKS_PROPOSAL",
      "CLINICAL_FLOOR_BLOCKS_PROPOSAL",
    ]) {
      expect(texto, `${codigo} llegó a la superficie del hogar`).not.toContain(codigo);
    }

    // Rosa es la dueña del dato, así que sí ve el detalle (is_self_member).
    const medico = await como(h.userId, () =>
      fila<{ clinical_overrides: { code: string }[] }>(
        "select clinical_overrides from public.adaptive_review_clinical_context where review_id = $1",
        [reviewId],
      ),
    );
    expect(medico!.clinical_overrides[0]!.code).toBe("CLINICAL_LIMIT_UNUSABLE");
  });

  /**
   * LÍMITE DECLARADO, NO ESCONDIDO. `reasons` y `missing_data` son jsonb de la
   * tabla del HOGAR y la 0040 sólo exige `jsonb_typeof(...) = 'array'`: guarda
   * verbatim lo que le manden. O sea que el filtro que impide que una razón
   * clínica nombre el nutriente o la cifra vive SÓLO en TypeScript
   * (`REASON_CODES_SIN_NUTRIENTE`, probado en
   * `domain/nutrition/adaptive/engine.test.ts`). Este test fija esa frontera
   * por escrito en vez de dejarla como un supuesto: si algún día la base sí
   * valida el contenido, se pone rojo y hay que venir a actualizarlo.
   */
  it("la base NO valida el contenido de reasons: el filtro vive en TypeScript", async () => {
    const h = await crearHogar("66666666-6666-4666-8666-666666666666", "Hogar frontera", "Tere");
    const fecha = await hoyDe(h.householdId);
    const reviewId = await como(h.userId, () =>
      fila<{ create_adaptive_review: string }>(
        "select public.create_adaptive_review($1, $2::date, 'D3'::public.adaptive_rolling_window, 'adaptive-nutrition/1.0.0', 'NO_CHANGE'::public.adaptive_verdict, $3::jsonb)",
        [
          h.memberId,
          fecha,
          JSON.stringify({
            ...PAYLOAD_BASE,
            adjustments: [],
            // Una razón clínica con nutriente y cifra: exactamente lo que el
            // motor de TS no emite nunca.
            reasons: [{ code: "CLINICAL_CEILING_APPLIED", nutrient: "protein_g", params: { max: 100 } }],
          }),
        ],
      ),
    );
    const r = await comoAdmin(() =>
      fila<{ reasons: { nutrient: string | null }[] }>(
        "select reasons from public.adaptive_nutrition_reviews where id = $1",
        [reviewId!.create_adaptive_review],
      ),
    );
    expect(
      r!.reasons[0]!.nutrient,
      "la base empezó a filtrar el contenido de reasons: actualizar este test y el de engine.test.ts",
    ).toBe("protein_g");
  });

  it("con una revisión clínica PENDING no se aplica ninguna propuesta adaptativa", async () => {
    const h = await crearHogar("66666666-6666-4666-8666-666666666665", "Hogar clínico", "Sonia");
    const reviewId = await proponer(h);
    const hoy = await hoyDe(h.householdId);

    await comoAdmin(async () => {
      await db.query(
        `insert into public.clinical_impact_reviews (household_id, member_id, trigger_kind, dedupe_key)
         values ($1, $2, 'LAB_RESULTS_CONFIRMED', 'IMPACT:TEST')`,
        [h.householdId, h.memberId],
      );
    });

    await como(h.userId, async () => {
      await expect(
        db.query(
          "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
          [
            reviewId,
            JSON.stringify([
              { goal_type: "PROTEIN_G", scope: "DAILY", valid_from: hoy, valid_until: masDias(hoy, 1) },
            ]),
          ],
        ),
      ).rejects.toThrow(/revisión de salud pendiente/i);
    });
  });
});

describe("0040 — un motor no escribe un objetivo permanente", () => {
  it("nutrition_goals rechaza SYSTEM o AI_PROPOSAL en estado ACTIVE", async () => {
    const h = await crearHogar("77777777-7777-4777-8777-777777777771", "Hogar objetivos", "Tomás");

    await comoAdmin(async () => {
      for (const source of ["SYSTEM", "AI_PROPOSAL"]) {
        await expect(
          db.query(
            `insert into public.nutrition_goals
               (member_id, goal_type, scope, unit, minimum, source, status)
             values ($1, 'PROTEIN_G', 'DAILY', 'g', 90, $2::public.goal_source, 'ACTIVE')`,
            [h.memberId, source],
          ),
        ).rejects.toThrow(/goals_engine_never_active|goal_ai_starts_proposed/i);
      }
    });
  });

  it("sólo toca member_temporary_targets: no escribe objetivos ni plan diario", async () => {
    const h = await crearHogar("77777777-7777-4777-8777-777777777772", "Hogar sólo temporal", "Ulises");
    const reviewId = await proponer(h);
    const hoy = await hoyDe(h.householdId);

    await como(h.userId, () =>
      db.query(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [
          reviewId,
          JSON.stringify([
            { goal_type: "PROTEIN_G", scope: "DAILY", valid_from: hoy, valid_until: masDias(hoy, 1) },
          ]),
        ],
      ),
    );

    await comoAdmin(async () => {
      expect(
        await filas("select 1 from public.nutrition_goals where member_id = $1", [h.memberId]),
      ).toHaveLength(0);
      expect(
        await filas("select 1 from public.member_daily_nutrition_plans where member_id = $1", [
          h.memberId,
        ]),
      ).toHaveLength(0);
      expect(
        await filas("select 1 from public.member_temporary_targets where member_id = $1", [
          h.memberId,
        ]),
      ).toHaveLength(1);
    });
  });

  it("un ajuste sólo rige desde hoy hacia adelante: un día vivido no se reescribe", async () => {
    const h = await crearHogar("77777777-7777-4777-8777-777777777773", "Hogar ayer", "Vera");
    const reviewId = await proponer(h);
    const hoy = await hoyDe(h.householdId);

    const res = await como(h.userId, () =>
      fila<{ resolve_adaptive_review: { applied: unknown[]; discarded: { code: string }[] } }>(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [
          reviewId,
          JSON.stringify([
            {
              goal_type: "PROTEIN_G",
              scope: "DAILY",
              valid_from: masDias(hoy, -1),
              valid_until: masDias(hoy, 1),
            },
          ]),
        ],
      ),
    );

    expect(res!.resolve_adaptive_review.applied).toHaveLength(0);
    expect(res!.resolve_adaptive_review.discarded).toEqual([
      expect.objectContaining({ code: "VALID_FROM_IN_PAST" }),
    ]);
  });

  it("no se puede aceptar un ajuste que la revisión nunca propuso", async () => {
    const h = await crearHogar("77777777-7777-4777-8777-777777777774", "Hogar inventado", "Wanda");
    const reviewId = await proponer(h);
    const hoy = await hoyDe(h.householdId);

    const res = await como(h.userId, () =>
      fila<{ resolve_adaptive_review: { applied: unknown[]; discarded: { code: string }[] } }>(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [
          reviewId,
          JSON.stringify([
            {
              goal_type: "ENERGY_KCAL",
              scope: "DAILY",
              maximum: 99999,
              valid_from: hoy,
              valid_until: masDias(hoy, 1),
            },
          ]),
        ],
      ),
    );

    expect(res!.resolve_adaptive_review.applied).toHaveLength(0);
    expect(res!.resolve_adaptive_review.discarded).toEqual([
      expect.objectContaining({ code: "NOT_IN_PROPOSAL" }),
    ]);
  });

  it("los números salen de la propuesta, no de quien acepta", async () => {
    const h = await crearHogar("77777777-7777-4777-8777-777777777775", "Hogar números", "Ximena");
    const reviewId = await proponer(h);
    const hoy = await hoyDe(h.householdId);

    await como(h.userId, () =>
      db.query(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [
          reviewId,
          JSON.stringify([
            {
              goal_type: "PROTEIN_G",
              scope: "DAILY",
              // Un caller que intenta escribir su propio número.
              minimum: 5,
              maximum: 5000,
              valid_from: hoy,
              valid_until: masDias(hoy, 1),
            },
          ]),
        ],
      ),
    );

    const t = await comoAdmin(() =>
      fila<{ minimum: string; maximum: string }>(
        "select minimum, maximum from public.member_temporary_targets where member_id = $1",
        [h.memberId],
      ),
    );
    expect(Number(t!.minimum)).toBe(90);
    expect(Number(t!.maximum)).toBe(130);
  });
});

describe("0040 — la expiración es mantención, no camino de lectura", () => {
  it("marca EXPIRED lo vencido y no toca lo vigente", async () => {
    const h = await crearHogar("88888888-8888-4888-8888-888888888881", "Hogar vencido", "Yamil");
    const hoy = await hoyDe(h.householdId);

    // Un ajuste vencido se fabrica por el único camino que existe: aprobarlo
    // hoy y correr el reloj no se puede, así que se aprueba con vigencia de un
    // día y se lo mira al día siguiente moviendo la fecha del hogar. Acá se usa
    // el atajo de admin porque lo que se prueba es la mantención, no el RPC.
    await comoAdmin(async () => {
      await db.query(
        `insert into public.member_temporary_targets
           (household_id, member_id, goal_type, valid_from, valid_until, provenance,
            approved_by, frozen_params, maximum)
         values ($1, $2, 'PROTEIN_G', $3::date, $4::date, 'HUMAN_OVERRIDE', $2, '{}'::jsonb, 130)`,
        [h.householdId, h.memberId, masDias(hoy, -3), masDias(hoy, -1)],
      );
      await db.query(
        `insert into public.member_temporary_targets
           (household_id, member_id, goal_type, valid_from, valid_until, provenance,
            approved_by, frozen_params, maximum)
         values ($1, $2, 'FIBER_G', $3::date, $4::date, 'HUMAN_OVERRIDE', $2, '{}'::jsonb, 40)`,
        [h.householdId, h.memberId, hoy, masDias(hoy, 1)],
      );
    });

    const n = await como(h.userId, () =>
      fila<{ expire_temporary_targets: number }>("select public.expire_temporary_targets($1)", [
        h.householdId,
      ]),
    );
    expect(n!.expire_temporary_targets).toBe(1);

    const estados = await comoAdmin(() =>
      filas<{ goal_type: string; status: string }>(
        "select goal_type, status from public.member_temporary_targets where member_id = $1 order by goal_type::text",
        [h.memberId],
      ),
    );
    expect(estados).toEqual([
      { goal_type: "FIBER_G", status: "ACTIVE" },
      { goal_type: "PROTEIN_G", status: "EXPIRED" },
    ]);
  });
});


/**
 * EL TECHO SE CONSULTABA UN SOLO DÍA, PERO EL OBJETIVO RIGE HASTA CUATRO.
 *
 * Los dos casos de acá abajo son los que reprodujo el ataque adversarial contra
 * la 0040, escritos tal cual:
 *
 *   A. La restricción ya está CONFIRMED cuando se propone y cuando se aplica,
 *      pero empieza MAÑANA. Antes, `app.adaptive_clinical_context` sacaba una
 *      foto de UN día —el de la firma— y no la veía: el objetivo quedaba
 *      rigiendo 130 g de proteína el día 2 y el día 3, con un techo clínico de
 *      100 g esos mismos días.
 *   B. Al aplicar no hay ninguna restricción; el techo se confirma DESPUÉS, con
 *      `valid_from` = hoy. Antes nadie volvía a mirar: el objetivo temporal
 *      seguía vivo 30 g por encima del techo hasta que vencía solo, porque
 *      `expire_temporary_targets` sólo cierra por fecha.
 *
 * En los dos casos `resolution_summary.discarded` venía vacío: el sistema creía
 * que había compuesto bien.
 *
 * PRUEBA POR MUTACIÓN (verificada revirtiendo el arreglo en el archivo):
 *   · volver `app.adaptive_clinical_context` a un solo día deja el máximo
 *     guardado en 130 y estos tests caen;
 *   · borrar el trigger `clinical_restrictions_close_temporary_targets` deja el
 *     objetivo del caso B en ACTIVE y ese test cae;
 *   · volver las columnas a numeric(10,3) guarda 100,001 sobre un techo de
 *     100,0005 y el test del redondeo cae.
 */
describe("0040 — la cota clínica manda en TODOS los días que el ajuste rige", () => {
  /** Una restricción clínica CONFIRMED con su vigencia dicha a mano. */
  async function restringirEntre(
    h: Hogar,
    tipo: "NUTRIENT_MAX" | "NUTRIENT_MIN",
    target: string,
    value: number | null,
    unit: string | null,
    validFrom: string,
    validUntil: string | null = null,
  ): Promise<void> {
    await comoAdmin(async () => {
      await db.query(
        `insert into public.member_clinical_restrictions
           (member_id, type, target, value, unit, severity, source, verification_status,
            valid_from, valid_until)
         values ($1, $2::public.clinical_restriction_type, $3, $4, $5, 'HARD',
                 'CLINICIAN_ENTERED', 'CONFIRMED', $6::date, $7::date)`,
        [h.memberId, tipo, target, value, unit, validFrom, validUntil],
      );
    });
  }

  /** Aplica la propuesta de proteína en el rango pedido. */
  async function aplicar(h: Hogar, reviewId: string, desde: string, hasta: string) {
    return como(h.userId, () =>
      fila<{ resolve_adaptive_review: { applied: unknown[]; discarded: unknown[] } }>(
        "select public.resolve_adaptive_review($1, 'APPLIED'::public.impact_review_status, $2::jsonb)",
        [
          reviewId,
          JSON.stringify([
            { goal_type: "PROTEIN_G", scope: "DAILY", valid_from: desde, valid_until: hasta },
          ]),
        ],
      ),
    );
  }

  async function objetivoDe(memberId: string) {
    return comoAdmin(() =>
      fila<{
        minimum: string;
        preferred: string;
        maximum: string;
        status: string;
        closed_at: string | null;
        valid_until: string;
      }>(
        `select minimum, preferred, maximum, status, closed_at,
                valid_until::text as valid_until
           from public.member_temporary_targets where member_id = $1`,
        [memberId],
      ),
    );
  }

  it("CASO A (propuesta): un techo que empieza MAÑANA ya recorta lo que se guarda hoy", async () => {
    const h = await crearHogar("9a000000-0000-4000-8000-000000000001", "Hogar mañana", "Tomás");
    const hoy = await hoyDe(h.householdId);
    // CONFIRMED, pero rige desde mañana: la foto de HOY no la veía.
    await restringirEntre(h, "NUTRIENT_MAX", "protein_g", 100, "g", masDias(hoy, 1));

    const reviewId = await proponer(h);

    const r = await comoAdmin(() =>
      fila<{ adjustments: { maximum: number; preferred: number }[]; clinical_capped: boolean }>(
        "select adjustments, clinical_capped from public.adaptive_nutrition_reviews where id = $1",
        [reviewId],
      ),
    );
    // La propuesta que ve la persona ya viene acotada por el techo de mañana:
    // lo que se guarda es lo que se va a poder aplicar, no un número que se
    // achica solo después.
    expect(r!.adjustments).toHaveLength(1);
    expect(Number(r!.adjustments[0]!.maximum)).toBeLessThanOrEqual(100);
    expect(Number(r!.adjustments[0]!.preferred)).toBeLessThanOrEqual(100);
    expect(r!.clinical_capped).toBe(true);
  });

  it("CASO A (aplicación): el techo de mañana acota el objetivo que rige hasta pasado mañana", async () => {
    const h = await crearHogar("9a000000-0000-4000-8000-000000000002", "Hogar rango", "Úrsula");
    const hoy = await hoyDe(h.householdId);

    // La propuesta nace SIN ninguna restricción a la vista: {90, 110, 130}.
    const reviewId = await proponer(h);
    const propuesta = await comoAdmin(() =>
      fila<{ adjustments: { maximum: number }[] }>(
        "select adjustments from public.adaptive_nutrition_reviews where id = $1",
        [reviewId],
      ),
    );
    expect(Number(propuesta!.adjustments[0]!.maximum)).toBe(130);

    // Recién ahora se confirma el techo, y empieza MAÑANA.
    await restringirEntre(h, "NUTRIENT_MAX", "protein_g", 100, "g", masDias(hoy, 1));

    // Se aplica HOY, con vigencia hasta pasado mañana: el día 2 y el día 3
    // caen bajo el techo.
    await aplicar(h, reviewId, hoy, masDias(hoy, 2));

    const t = await objetivoDe(h.memberId);
    expect(t).not.toBeNull();
    expect(t!.status).toBe("ACTIVE");
    expect(t!.valid_until).toBe(masDias(hoy, 2));
    // ESTO es el hallazgo: antes acá había 130.
    expect(Number(t!.maximum)).toBeLessThanOrEqual(100);
    expect(Number(t!.preferred)).toBeLessThanOrEqual(100);
    expect(Number(t!.minimum)).toBeLessThanOrEqual(100);

    // Y el recorte quedó dicho en el canal médico, no en el del hogar.
    const medico = await comoAdmin(() =>
      fila<{ clinical_overrides: { code: string }[] }>(
        "select clinical_overrides from public.adaptive_review_clinical_context where review_id = $1",
        [reviewId],
      ),
    );
    expect(medico!.clinical_overrides.map((o) => o.code)).toContain("CLINICAL_BOUNDS_APPLIED");
  });

  it("CASO B: el techo que se confirma DESPUÉS revoca el objetivo que ya estaba vigente", async () => {
    const h = await crearHogar("9a000000-0000-4000-8000-000000000003", "Hogar después", "Valeria");
    const hoy = await hoyDe(h.householdId);

    const reviewId = await proponer(h);
    await aplicar(h, reviewId, hoy, masDias(hoy, 2));

    const antes = await objetivoDe(h.memberId);
    expect(antes!.status).toBe("ACTIVE");
    expect(Number(antes!.maximum)).toBe(130);

    // El techo llega después y rige desde HOY, o sea sobre un objetivo vivo.
    await restringirEntre(h, "NUTRIENT_MAX", "protein_g", 100, "g", hoy);

    const despues = await objetivoDe(h.memberId);
    // No se reescribe el número aprobado —eso sería aplicar un ajuste que nadie
    // aprobó—: se CIERRA, que es lo que la tabla sabe hacer.
    expect(despues!.status).toBe("REVOKED");
    expect(despues!.closed_at).not.toBeNull();
    expect(Number(despues!.maximum)).toBe(130);

    // El motivo completo vive en el canal con permiso médico.
    const medico = await comoAdmin(() =>
      fila<{ clinical_overrides: { code: string; conflict?: { code: string } }[] }>(
        "select clinical_overrides from public.adaptive_review_clinical_context where review_id = $1",
        [reviewId],
      ),
    );
    const cierre = medico!.clinical_overrides.find(
      (o) => o.code === "TEMPORARY_TARGET_REVOKED_BY_CLINICAL_BOUND",
    );
    expect(cierre).toBeDefined();
    expect(cierre!.conflict!.code).toBe("CLINICAL_CEILING_EXCEEDED");

    // Y en la superficie del hogar no aparece la palabra "clínico" por ningún
    // lado: sólo que el ajuste se cerró.
    const auditoria = await comoAdmin(() =>
      fila<{ metadata: Record<string, unknown> }>(
        "select metadata from public.audit_events where action = 'TEMPORARY_TARGET_REVOKED' and household_id = $1",
        [h.householdId],
      ),
    );
    expect(auditoria!.metadata).toEqual({ goal_type: "PROTEIN_G", code: "REVALIDATION" });
  });

  it("una restricción que empieza DESPUÉS del ajuste no lo toca: es solape, no 'todas'", async () => {
    const h = await crearHogar("9a000000-0000-4000-8000-000000000004", "Hogar lejano", "Wilson");
    const hoy = await hoyDe(h.householdId);
    // Empieza cinco días más allá: no comparte ni un día con [hoy, hoy+2] ni
    // con el horizonte de la propuesta.
    await restringirEntre(h, "NUTRIENT_MAX", "protein_g", 100, "g", masDias(hoy, 5));

    const reviewId = await proponer(h);
    await aplicar(h, reviewId, hoy, masDias(hoy, 2));

    const t = await objetivoDe(h.memberId);
    expect(t!.status).toBe("ACTIVE");
    // Acotar de más también es acotar mal: la unión es sobre el rango, no sobre
    // la historia clínica entera.
    expect(Number(t!.maximum)).toBe(130);
  });

  it("el redondeo al guardar NUNCA sube por sobre el techo", async () => {
    const h = await crearHogar("9a000000-0000-4000-8000-000000000005", "Hogar decimal", "Ximena");
    const hoy = await hoyDe(h.householdId);
    // numeric(12,4) del lado clínico: cuatro decimales exactos.
    await restringirEntre(h, "NUTRIENT_MAX", "protein_g", 100.0005, "g", masDias(hoy, -1));

    const reviewId = await proponer(h);
    await aplicar(h, reviewId, hoy, masDias(hoy, 1));

    const t = await objetivoDe(h.memberId);
    // Con numeric(10,3) esto guardaba 100,001, que es MÁS que el techo.
    expect(Number(t!.maximum)).toBeLessThanOrEqual(100.0005);
    expect(Number(t!.preferred)).toBeLessThanOrEqual(100.0005);
  });

  it("TERCERA PARED: un objetivo por sobre el techo no se puede escribir ni a mano", async () => {
    const h = await crearHogar("9a000000-0000-4000-8000-000000000006", "Hogar pared", "Yerko");
    const hoy = await hoyDe(h.householdId);
    await restringirEntre(h, "NUTRIENT_MAX", "protein_g", 100, "g", masDias(hoy, 2));

    await comoAdmin(async () => {
      // Admin, saltándose RLS y privilegios: igual rebota, porque la invariante
      // es del dato y no del camino.
      await expect(
        db.query(
          `insert into public.member_temporary_targets
             (household_id, member_id, goal_type, valid_from, valid_until, provenance,
              approved_by, frozen_params, minimum, preferred, maximum)
           values ($1, $2, 'PROTEIN_G', $3::date, $4::date, 'ADAPTIVE_ENGINE', $2, '{}'::jsonb,
                   90, 110, 130)`,
          [h.householdId, h.memberId, hoy, masDias(hoy, 2)],
        ),
      ).rejects.toThrow(/indicación de salud/i);

      // El mismo objetivo, recortado, sí entra: la pared acota, no prohíbe.
      await db.query(
        `insert into public.member_temporary_targets
           (household_id, member_id, goal_type, valid_from, valid_until, provenance,
            approved_by, frozen_params, minimum, preferred, maximum)
         values ($1, $2, 'PROTEIN_G', $3::date, $4::date, 'ADAPTIVE_ENGINE', $2, '{}'::jsonb,
                 90, 100, 100)`,
        [h.householdId, h.memberId, hoy, masDias(hoy, 2)],
      );
    });

    const t = await objetivoDe(h.memberId);
    expect(t!.status).toBe("ACTIVE");
    expect(Number(t!.maximum)).toBe(100);
  });

  it("un techo SIN CIFRA vigente en cualquier día del rango también cierra el ajuste vivo", async () => {
    const h = await crearHogar("9a000000-0000-4000-8000-000000000007", "Hogar sin cifra", "Zoe");
    const hoy = await hoyDe(h.householdId);

    const reviewId = await proponer(h);
    await aplicar(h, reviewId, hoy, masDias(hoy, 2));
    expect((await objetivoDe(h.memberId))!.status).toBe("ACTIVE");

    // "Hay un límite y no sabemos cuál" jamás es "no hay límite", y tampoco es
    // "el objetivo de arriba sigue bien".
    await restringirEntre(h, "NUTRIENT_MAX", "protein_g", null, "g", masDias(hoy, 2));

    const t = await objetivoDe(h.memberId);
    expect(t!.status).toBe("REVOKED");
  });
});
