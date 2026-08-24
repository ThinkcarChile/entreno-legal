import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekStart } from "@/domain/nutrition/calendar";
import { servingRowSchema } from "@/app/shopping/queries";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Hardening post-Sprint 6 — las cuatro correcciones pedidas antes del Sprint 7:
 *
 *   1. datos incompletos en una porción confirmada fallan, no se vuelven G/RAW;
 *   2. rendimientos con procedencia, sin reescribir historia;
 *   3. los RPC SECURITY DEFINER rechazan UUIDs de otro hogar;
 *   4. lo usado por el historial se archiva, no se borra.
 *
 * Todo con rol authenticated real.
 */

const USER_A = "00000000-0000-0000-0000-0000000000f1";
const USER_B = "00000000-0000-0000-0000-0000000000f2";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };
let versionPollo: string;
let perfilA: string;
let perfilB: string;
let almuerzoA: string;
let almuerzoB: string;
let planA: string;
let planB: string;

const SEMANA = weekStart("2026-09-21");
const LUNES = "2026-09-21";

async function armarComida(userId: string, householdId: string) {
  return h.como(userId, async () => {
    const plan = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, $2)",
      [householdId, SEMANA],
    ))!.ensure_weekly_plan;
    const dia = (await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
      [plan, LUNES],
    ))!.id;
    const asig = (await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
       select $1, 'LUNCH', 'RECIPE', v.template_id, v.id
       from public.meal_template_versions v where v.id = $2
       returning id`,
      [dia, versionPollo],
    ))!.id;
    return { plan, asig };
  });
}

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar Hard A", "Fran");
  hogarB = await crearHogar(h, USER_B, "Hogar Hard B", "Vecino");

  versionPollo = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;

  for (const [user, hogar] of [
    [USER_A, hogarA],
    [USER_B, hogarB],
  ] as const) {
    await h.como(user, async () => {
      const perfil = (await h.fila<{ publish_nutrition_profile: string }>(
        `select public.publish_nutrition_profile($1, 'BASIC', $2, '{}'::jsonb,
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'hardening')`,
        [hogar.memberId, `firma-hard-${hogar.memberId}`],
      ))!.publish_nutrition_profile;
      if (user === USER_A) perfilA = perfil;
      else perfilB = perfil;
    });
  }

  const a = await armarComida(USER_A, hogarA.householdId);
  planA = a.plan;
  almuerzoA = a.asig;
  const b = await armarComida(USER_B, hogarB.householdId);
  planB = b.plan;
  almuerzoB = b.asig;
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

function porcion(
  memberId: string,
  profileId: string,
  componente: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    member_id: memberId,
    version_id: versionPollo,
    profile_id: profileId,
    optimizer_version: "portion-optimizer/1.0.0",
    meal_type: "LUNCH",
    serving_date: LUNES,
    fit: "COMPATIBLE",
    adaptation_level: 0,
    score: 90,
    nutrition: { energy_kcal: 500 },
    completeness: { energy_kcal: "COMPLETE" },
    reasons: [],
    unmet_constraints: [],
    components: [
      {
        label: "Pechuga de pollo (sin piel)",
        base_quantity: 180,
        proposed_quantity: 180,
        unit: "G",
        weight_basis: "RAW",
        cooking_method: "BAKED",
        added_fat_g: 0,
        sort_order: 1,
        ...componente,
      },
    ],
    substitutions: [] as unknown[],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. Sin unidad ni base de peso NO hay valores por defecto
// ---------------------------------------------------------------------------
describe("hardening 1: una porción confirmada no adivina", () => {
  it("componente sin unidad: la confirmación falla con mensaje claro", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
          almuerzoA,
          JSON.stringify([porcion(hogarA.memberId, perfilA, { unit: null })]),
        ]),
      ),
    ).rejects.toThrow(/sin unidad/i);
  });

  it("componente sin base de peso: la confirmación falla, no se vuelve RAW", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
          almuerzoA,
          JSON.stringify([porcion(hogarA.memberId, perfilA, { weight_basis: null })]),
        ]),
      ),
    ).rejects.toThrow(/sin base de peso/i);
  });

  it("nada quedó guardado a medias tras los rechazos", async () => {
    const filas = await h.como(USER_A, () =>
      h.filas("select 1 from public.member_serving_projections where assignment_id = $1", [
        almuerzoA,
      ]),
    );
    expect(filas).toHaveLength(0);
  });

  it("la frontera de lectura también es estricta: base de peso desconocida explota", () => {
    const fila = {
      id: "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f",
      assignment_id: "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e60",
      member_id: "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e61",
      meal_type: "LUNCH",
      serving_date: "2026-09-21",
      household_members: { display_name: "Fran" },
      member_serving_components: [
        {
          ingredient_id: null,
          product_id: null,
          label: "Algo",
          proposed_quantity: 100,
          unit: "G",
          weight_basis: "ENCURTIDO", // valor que la base jamás debería tener
          cooking_method: null,
          added_fat_g: null,
        },
      ],
    };
    expect(() => servingRowSchema.parse(fila)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Rendimientos con procedencia; la historia no se reescribe
// ---------------------------------------------------------------------------
describe("hardening 2: ingredient_yields con procedencia", () => {
  it("los factores del seed declaran fuente y estado de verificación", async () => {
    const filas = await h.como(USER_A, () =>
      h.filas<{ source: string; verification_status: string; household_id: string | null }>(
        "select source, verification_status, household_id from public.ingredient_yields",
      ),
    );
    expect(filas.length).toBeGreaterThan(0);
    for (const f of filas) {
      expect(f.source).toBe("SEED_REFERENCE");
      expect(f.verification_status).toBe("UNVERIFIED");
      expect(f.household_id).toBeNull();
    }
  });

  it("cambiar un factor NO reescribe una revisión ya generada", async () => {
    // Lista con una revisión que congeló yield_factor 2.8.
    const lista = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `insert into public.shopping_lists (household_id, plan_id, created_by)
         values ($1, $2, $3) returning id`,
        [hogarA.householdId, planA, hogarA.memberId],
      ),
    ))!.id;

    await h.como(USER_A, async () => {
      await h.db.query(
        `select public.generate_shopping_revision($1, 'firma-y1', 'shopping-engine/1.0.0', '[]'::jsonb,
           '[{"label":"Arroz blanco","yieldFactor":2.8,"requiredQuantity":268}]'::jsonb,
           $2::jsonb)`,
        [
          lista,
          JSON.stringify([
            {
              line_key: "k-arroz",
              ingredient_id: null,
              product_id: null,
              label: "Arroz blanco",
              unit: "G",
              required_quantity: 268,
              purchase_basis: "RAW",
              cooked_quantity: 750,
              yield_factor: 2.8,
              unresolved: false,
              unresolved_reason: null,
              provenance: [],
            },
          ]),
        ],
      );
    });

    // El catálogo cambia (curado nuevo)…
    await h.comoAdmin(async () => {
      await h.db.query(
        `update public.ingredient_yields set yield_factor = 3.0, verification_status = 'VERIFIED',
           source = 'medición de prueba', updated_at = now()
         where cooking_method = 'BOILED'
           and ingredient_id = (select id from public.ingredients where canonical_name = 'arroz blanco')`,
      );
    });

    // …y la revisión histórica sigue diciendo 2.8, congelada.
    const revision = await h.como(USER_A, () =>
      h.fila<{ payload: unknown }>(
        "select payload from public.shopping_list_revisions where list_id = $1 and revision_number = 1",
        [lista],
      ),
    );
    expect(JSON.stringify(revision!.payload)).toContain("2.8");

    const item = await h.como(USER_A, () =>
      h.fila<{ yield_factor: string }>(
        "select yield_factor from public.shopping_list_items where list_id = $1 and line_key = 'k-arroz'",
        [lista],
      ),
    );
    expect(Number(item!.yield_factor)).toBe(2.8);
  });

  it("un hogar puede tener su propio factor sin chocar con el global", async () => {
    const arroz = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'arroz blanco'",
    ))!.id;
    await h.comoAdmin(async () => {
      await h.db.query(
        `insert into public.ingredient_yields
           (ingredient_id, cooking_method, yield_factor, household_id, source, verification_status)
         values ($1, 'BOILED', 2.6, $2, 'medido en casa', 'HOUSEHOLD_MEASURED')`,
        [arroz, hogarA.householdId],
      );
    });
    // El hogar B ve el global pero NO el factor privado del hogar A.
    const desdeB = await h.como(USER_B, () =>
      h.filas<{ household_id: string | null }>(
        "select household_id from public.ingredient_yields where ingredient_id = $1",
        [arroz],
      ),
    );
    expect(desdeB.every((f) => f.household_id === null)).toBe(true);
    const desdeA = await h.como(USER_A, () =>
      h.filas("select 1 from public.ingredient_yields where ingredient_id = $1 and household_id = $2", [
        arroz,
        hogarA.householdId,
      ]),
    );
    expect(desdeA).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. UUIDs de otro hogar: rechazados en los RPC SECURITY DEFINER
// ---------------------------------------------------------------------------
describe("hardening 3: el hogar B no puede inyectar recursos privados del A", () => {
  let ingredientePrivadoA: string;

  it("preparación: el hogar A crea un alimento privado", async () => {
    ingredientePrivadoA = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `insert into public.ingredients (canonical_name, display_name, category_id, household_id)
         values ('secreto de fran', 'Secreto de Fran',
                 (select id from public.ingredient_categories where code = 'OTHER'), $1)
         returning id`,
        [hogarA.householdId],
      ),
    ))!.id;
    expect(ingredientePrivadoA).toBeTruthy();
  });

  it("confirm_meal_assignment rechaza el PERFIL de otra persona", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
          almuerzoB,
          JSON.stringify([porcion(hogarB.memberId, perfilA, {})]), // perfil del hogar A
        ]),
      ),
    ).rejects.toThrow(/perfil.*no pertenece/i);
  });

  it("confirm_meal_assignment rechaza un ALIMENTO privado de otro hogar", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
          almuerzoB,
          JSON.stringify([
            porcion(hogarB.memberId, perfilB, { ingredient_id: ingredientePrivadoA }),
          ]),
        ]),
      ),
    ).rejects.toThrow(/no pertenece a este hogar/i);
  });

  it("confirm_meal_assignment rechaza una SUSTITUCIÓN hacia un alimento ajeno", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
          almuerzoB,
          JSON.stringify([
            porcion(hogarB.memberId, perfilB, {}, {
              substitutions: [{ component_id: null, from_ingredient_id: null, to_ingredient_id: ingredientePrivadoA, reason_code: "SOFT_PREFERENCE" }],
            }),
          ]),
        ]),
      ),
    ).rejects.toThrow(/otro hogar/i);
  });

  it("generate_shopping_revision rechaza items con alimentos ajenos", async () => {
    const listaB = (await h.como(USER_B, () =>
      h.fila<{ id: string }>(
        `insert into public.shopping_lists (household_id, plan_id, created_by)
         values ($1, $2, $3) returning id`,
        [hogarB.householdId, planB, hogarB.memberId],
      ),
    ))!.id;

    await expect(
      h.como(USER_B, () =>
        h.db.query(
          `select public.generate_shopping_revision($1, 'firma-mala', 'x', '[]'::jsonb, '[]'::jsonb, $2::jsonb)`,
          [
            listaB,
            JSON.stringify([
              {
                line_key: "k-robo",
                ingredient_id: ingredientePrivadoA,
                product_id: null,
                label: "Secreto de Fran",
                unit: "G",
                required_quantity: 100,
                purchase_basis: "RAW",
                cooked_quantity: null,
                yield_factor: null,
                unresolved: false,
                unresolved_reason: null,
                provenance: [],
              },
            ]),
          ],
        ),
      ),
    ).rejects.toThrow(/no pertenece a este hogar/i);
  });

  it("con recursos globales y propios, la confirmación del hogar B funciona", async () => {
    const pollo = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
    ))!.id;
    const n = await h.como(USER_B, () =>
      h.fila<{ confirm_meal_assignment: number }>(
        "select public.confirm_meal_assignment($1, $2::jsonb)",
        [
          almuerzoB,
          JSON.stringify([porcion(hogarB.memberId, perfilB, { ingredient_id: pollo })]),
        ],
      ),
    );
    expect(Number(n!.confirm_meal_assignment)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. El historial no se borra: se archiva
// ---------------------------------------------------------------------------
describe("hardening 4: lo usado por el historial se archiva, no se borra", () => {
  it("un alimento en porciones confirmadas no se puede borrar", async () => {
    const pollo = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
    ))!.id;
    // El almuerzo del hogar B (test anterior) referencia el pollo global.
    await expect(
      h.comoAdmin(() => h.db.query("delete from public.ingredients where id = $1", [pollo])),
    ).rejects.toThrow(/archívalo|is_active/i);
  });

  it("archivar sí funciona: is_active = false y la identidad histórica queda", async () => {
    const arandanos = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'arandanos'",
    ))!.id;
    await h.comoAdmin(async () => {
      await h.db.query("update public.ingredients set is_active = false where id = $1", [arandanos]);
    });
    const fila = await h.fila<{ is_active: boolean }>(
      "select is_active from public.ingredients where id = $1",
      [arandanos],
    );
    expect(fila!.is_active).toBe(false);
    // se deja como estaba
    await h.comoAdmin(async () => {
      await h.db.query("update public.ingredients set is_active = true where id = $1", [arandanos]);
    });
  });

  it("un alimento SIN historial sí se puede borrar", async () => {
    const efimero = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `insert into public.ingredients (canonical_name, display_name, category_id, household_id)
         values ('efimero', 'Efímero',
                 (select id from public.ingredient_categories where code = 'OTHER'), $1)
         returning id`,
        [hogarA.householdId],
      ),
    ))!.id;
    // El borrado de catálogo es un camino de admin: RLS ni siquiera deja al
    // hogar intentarlo, así que el trigger se prueba con el rol que sí llega.
    await h.comoAdmin(async () => {
      await h.db.query("delete from public.ingredients where id = $1", [efimero]);
    });
    const fila = await h.fila("select 1 from public.ingredients where id = $1", [efimero]);
    expect(fila).toBeNull();
  });

  it("un producto en la lista de compras tampoco se puede borrar", async () => {
    // Producto del hogar A usado en un item de lista.
    const producto = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `insert into public.commercial_products (household_id, name, package_quantity, package_unit)
         values ($1, 'Yogur de prueba', 140, 'G') returning id`,
        [hogarA.householdId],
      ),
    ))!.id;
    const lista = (await h.como(USER_A, () =>
      h.fila<{ id: string }>("select id from public.shopping_lists where plan_id = $1", [planA]),
    ))!.id;
    await h.como(USER_A, async () => {
      await h.db.query(
        `insert into public.shopping_list_items (list_id, source, label, unit, product_id, planned_quantity, purchase_basis)
         values ($1, 'MANUAL', 'Yogur de prueba', 'UNIT', $2, 5, 'COMMERCIAL_PACKAGE')`,
        [lista, producto],
      );
    });
    await expect(
      h.comoAdmin(() =>
        h.db.query("delete from public.commercial_products where id = $1", [producto]),
      ),
    ).rejects.toThrow(/archívalo|is_active/i);
  });
});
