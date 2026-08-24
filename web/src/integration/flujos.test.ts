import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profileFromRows } from "@/app/family/nutrition-queries";
import { componentRowSchema, toComponent } from "@/app/recipes/queries";
import { parseRows } from "@/lib/supabase/rows";
import type { MemberNutritionProfile } from "@/domain/nutrition/types";
import { projectFamilyServings } from "@/domain/portions/family";
import type { PortionComponent } from "@/domain/portions/optimizer";
import type { SlotType } from "@/domain/recipes/types";
import {
  componentesDe,
  crearHogar,
  levantarBase,
  patronDe,
  SELECT_PERFIL,
  type Harness,
} from "./harness";

/**
 * Pruebas de integración: base de datos real → capa de datos → dominio.
 *
 * Cubren la costura donde vivían los tres bugs graves del Sprint 4. Las filas
 * salen de un PostgreSQL de verdad, con sus tipos y sus `numeric` que llegan
 * como texto; nada está escrito a mano.
 */

const USER_A = "00000000-0000-0000-0000-0000000000a1";
const USER_B = "00000000-0000-0000-0000-0000000000b1";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };
let versionPollo: string;
let idPollo: string;
let idMerluza: string;

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar A", "Ana");
  hogarB = await crearHogar(h, USER_B, "Hogar B", "Beto");

  await h.como(USER_A, async () => {
    await h.db.query("select public.seed_demo_family_profiles($1)", [hogarA.householdId]);
  });

  const version = await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  );
  versionPollo = version!.id;

  idPollo = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;
  idMerluza = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'merluza'",
  ))!.id;
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

/** Arma el perfil de un integrante desde filas reales, como lo hace la app. */
async function perfilDe(memberId: string, nombre: string): Promise<MemberNutritionProfile> {
  return profileFromRows(
    {
      tracking: await h.fila(SELECT_PERFIL.tracking, [memberId]),
      goals: await h.filas(SELECT_PERFIL.goals, [memberId]),
      pattern: await patronDe(h, memberId),
      preferences: await h.filas(SELECT_PERFIL.preferences, [memberId]),
      cooking: await h.filas(SELECT_PERFIL.cooking, [memberId]),
      fat: await h.fila(SELECT_PERFIL.fat, [memberId]),
      snapshot: await h.fila(SELECT_PERFIL.snapshot, [memberId]),
    },
    memberId,
    nombre,
  );
}

/** Componentes de la receta, mapeados con el mismo código que usa la app. */
async function componentesDeReceta(versionId: string): Promise<PortionComponent[]> {
  const filas = await componentesDe(h, versionId);
  return parseRows(componentRowSchema, filas, "componentes").map((row, i) => {
    const slotType = (filas[i] as { slot_type: SlotType }).slot_type;
    const c = toComponent(row, slotType);
    return {
      id: c.id,
      slotId: c.slotId,
      label: c.label,
      slotType: c.slotType,
      quantity: c.quantity,
      unit: c.unit,
      weightBasis: c.weightBasis,
      nutrition: c.nutrition,
      cookingMethod: c.cookingMethod,
      adjustability: c.adjustability,
      role: c.role,
      minQuantity: c.minQuantity,
      maxQuantity: c.maxQuantity,
      productId: c.target.kind === "PRODUCT" ? c.target.productId : null,
      ingredientId: c.target.kind === "INGREDIENT" ? c.target.ingredientId : null,
      categoryId: c.categoryId,
      isOptional: c.isOptional,
    };
  });
}

async function miembroPorNombre(nombre: string): Promise<string> {
  const fila = await h.fila<{ id: string }>(
    "select id from public.household_members where household_id = $1 and display_name = $2",
    [hogarA.householdId, nombre],
  );
  return fila!.id;
}

// ---------------------------------------------------------------------------
describe("carga de familia", () => {
  it("el hogar trae a los cinco integrantes con sus roles", async () => {
    const miembros = await h.como(USER_A, () =>
      h.filas<{ display_name: string }>(
        `select display_name from public.household_members
         where household_id = $1 order by display_name`,
        [hogarA.householdId],
      ),
    );
    expect(miembros.map((m) => m.display_name).sort()).toEqual(
      ["Ana", "Constanza", "Paula", "Ricardo", "Sebastián"].sort(),
    );
  });

  it("cada perfil se arma desde filas reales, con su modo de seguimiento", async () => {
    const ana = await perfilDe(hogarA.memberId, "Ana");
    const paula = await perfilDe(await miembroPorNombre("Paula"), "Paula");

    expect(ana.trackingMode).toBe("FULL");
    expect(paula.trackingMode).toBe("OFF");
    // Ana hereda la configuración de Francisco del seed: ayuno, almuerzo primero.
    expect(ana.pattern.usesFastingPattern).toBe(true);
    expect(ana.mealTargets.LUNCH?.PROTEIN_G?.preferred).toBe(65);
    expect(ana.mealTargets.LUNCH?.ENERGY_KCAL?.maximum).toBe(800);
    expect(paula.mealTargets.LUNCH).toBeUndefined();
  });

  it("los numeric de PostgreSQL llegan como números, no como texto", async () => {
    const ana = await perfilDe(hogarA.memberId, "Ana");
    expect(typeof ana.dailyTargets.PROTEIN_G?.preferred).toBe("number");
    const componentes = await componentesDeReceta(versionPollo);
    expect(componentes.every((c) => typeof c.quantity === "number")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("alergia HARD bloquea la receta", () => {
  it("una alergia al pollo deja la receta NO_COMPATIBLE y sin gramos", async () => {
    const constanza = await miembroPorNombre("Constanza");
    await h.como(USER_A, async () => {
      await h.db.query(
        `insert into public.member_preferences (member_id, preference_type, target_kind, target_id)
         values ($1, 'ALLERGY', 'INGREDIENT', $2)
         on conflict (member_id, target_kind, target_id) do update set preference_type = 'ALLERGY'`,
        [constanza, idPollo],
      );
    });

    const perfil = await perfilDe(constanza, "Constanza");
    // Esto es exactamente lo que el cast rompía: la preferencia tiene que llegar.
    expect(perfil.preferences).toHaveLength(1);
    expect(perfil.preferences[0]!.preferenceType).toBe("ALLERGY");
    expect(perfil.preferences[0]!.targetId).toBe(idPollo);

    const proyeccion = projectFamilyServings({
      versionId: versionPollo,
      components: await componentesDeReceta(versionPollo),
      baseServings: 5,
      mealType: "LUNCH",
      members: [{ profile: perfil }],
    });

    expect(proyeccion.servings[0]!.fit).toBe("NOT_COMPATIBLE");
    expect(proyeccion.servings[0]!.components.every((c) => c.proposedQuantity === 0)).toBe(true);
    expect(proyeccion.totals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("dislike SOFT propone sustitución", () => {
  it("propone merluza sin aplicarla, y aplicarla corrige los totales", async () => {
    const sebastian = await miembroPorNombre("Sebastián");
    await h.como(USER_A, async () => {
      await h.db.query(
        `insert into public.member_preferences (member_id, preference_type, target_kind, target_id)
         values ($1, 'DISLIKE', 'INGREDIENT', $2)
         on conflict (member_id, target_kind, target_id) do update set preference_type = 'DISLIKE'`,
        [sebastian, idPollo],
      );
    });

    const perfil = await perfilDe(sebastian, "Sebastián");
    const componentes = await componentesDeReceta(versionPollo);

    const alternativas = (
      await h.filas<{ slot_id: string; ingredient_id: string; display_name: string }>(
        `select a.slot_id, a.ingredient_id, i.display_name
         from public.meal_slot_alternatives a
         join public.meal_slots s on s.id = a.slot_id
         join public.ingredients i on i.id = a.ingredient_id
         where s.version_id = $1`,
        [versionPollo],
      )
    ).map((a) => ({
      slotId: a.slot_id,
      ingredientId: a.ingredient_id,
      label: a.display_name,
      nutrition: null,
    }));

    const sinAplicar = projectFamilyServings({
      versionId: versionPollo,
      components: componentes,
      alternatives: alternativas,
      baseServings: 5,
      mealType: "LUNCH",
      members: [{ profile: perfil }],
    });

    const sugerencias = sinAplicar.servings[0]!.suggestions;
    expect(sugerencias.length).toBeGreaterThan(0);
    // Se propone, NO se aplica: el pollo sigue en la porción.
    expect(sinAplicar.servings[0]!.components.some((c) => c.label.includes("pollo"))).toBe(true);

    const merluza = alternativas.find((a) => a.ingredientId === idMerluza)!;
    const fichaMerluza = await h.fila<Record<string, unknown>>(
      `select weight_basis, basis_unit, energy_kcal, protein_g, carbohydrates_g, fat_g
       from public.nutrition_facts where ingredient_id = $1 and weight_basis = 'RAW'`,
      [idMerluza],
    );

    const componentePollo = componentes.find((c) => c.ingredientId === idPollo)!;
    const aplicado = projectFamilyServings({
      versionId: versionPollo,
      components: componentes,
      alternatives: alternativas,
      baseServings: 5,
      mealType: "LUNCH",
      members: [
        {
          profile: perfil,
          substitutions: [
            {
              componentId: componentePollo.id,
              ingredientId: idMerluza,
              label: merluza.label,
              nutrition: {
                weightBasis: "RAW",
                basisUnit: "G",
                values: {
                  energy_kcal: Number(fichaMerluza!.energy_kcal),
                  protein_g: Number(fichaMerluza!.protein_g),
                  carbohydrates_g: Number(fichaMerluza!.carbohydrates_g),
                  fat_g: Number(fichaMerluza!.fat_g),
                },
              },
            },
          ],
        },
      ],
    });

    const etiquetas = aplicado.totals.map((t) => t.label);
    expect(etiquetas).toContain("Merluza");
    expect(etiquetas.filter((l) => l.includes("pollo"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("cambiar un objetivo recalcula a una sola persona", () => {
  it("sube la porción de Sebastián y deja intactas las demás", async () => {
    const sebastian = await miembroPorNombre("Sebastián");
    const componentes = await componentesDeReceta(versionPollo);

    const perfiles = async () => [
      await perfilDe(hogarA.memberId, "Ana"),
      await perfilDe(sebastian, "Sebastián"),
      await perfilDe(await miembroPorNombre("Paula"), "Paula"),
    ];

    const proyectar = async () =>
      projectFamilyServings({
        versionId: versionPollo,
        components: componentes,
        baseServings: 5,
        mealType: "LUNCH",
        members: (await perfiles()).map((profile) => ({ profile })),
      });

    const antes = await proyectar();

    await h.como(USER_A, async () => {
      await h.db.query(
        `update public.nutrition_goals set status = 'SUPERSEDED'
         where member_id = $1 and goal_type = 'PROTEIN_G' and scope = 'PER_MEAL' and status = 'ACTIVE'`,
        [sebastian],
      );
      await h.db.query(
        `insert into public.nutrition_goals
           (member_id, goal_type, scope, meal_type, minimum, preferred, maximum, unit)
         values ($1, 'PROTEIN_G', 'PER_MEAL', 'LUNCH', 60, 90, 110, 'g')`,
        [sebastian],
      );
    });

    const despues = await proyectar();

    const pollo = (p: typeof antes, quien: string) =>
      p.servings
        .find((s) => s.memberName === quien)!
        .components.find((c) => c.ingredientId === idPollo)!.proposedQuantity;

    expect(pollo(despues, "Sebastián")).toBeGreaterThan(pollo(antes, "Sebastián"));
    expect(pollo(despues, "Ana")).toBeCloseTo(pollo(antes, "Ana"), 9);
    expect(pollo(despues, "Paula")).toBeCloseTo(pollo(antes, "Paula"), 9);

    const totalAntes = antes.totals.find((t) => t.label.includes("pollo"))!.total;
    const totalDespues = despues.totals.find((t) => t.label.includes("pollo"))!.total;
    const delta = pollo(despues, "Sebastián") - pollo(antes, "Sebastián");
    expect(totalDespues - totalAntes).toBeCloseTo(delta, 6);
  });
});

// ---------------------------------------------------------------------------
describe("excepción del día", () => {
  it("guardada en la base, cambia solo esa fecha", async () => {
    const fecha = "2026-09-05";
    await h.como(USER_A, async () => {
      const plan = await h.fila<{ id: string }>(
        `insert into public.member_daily_nutrition_plans (member_id, plan_date, note)
         values ($1, $2, 'asado') returning id`,
        [hogarA.memberId, fecha],
      );
      await h.db.query(
        `insert into public.member_daily_plan_meals (plan_id, meal_type, energy_max)
         values ($1, 'LUNCH', 1200)`,
        [plan!.id],
      );
    });

    const guardado = await h.como(USER_A, () =>
      h.fila<{ energy_max: string }>(
        `select m.energy_max from public.member_daily_plan_meals m
         join public.member_daily_nutrition_plans p on p.id = m.plan_id
         where p.member_id = $1 and p.plan_date = $2 and m.meal_type = 'LUNCH'`,
        [hogarA.memberId, fecha],
      ),
    );
    expect(Number(guardado!.energy_max)).toBe(1200);

    // El patrón habitual NO cambió.
    const perfil = await perfilDe(hogarA.memberId, "Ana");
    expect(perfil.mealTargets.LUNCH?.ENERGY_KCAL?.maximum).toBe(800);

    const componentes = await componentesDeReceta(versionPollo);
    const conExcepcion = projectFamilyServings({
      versionId: versionPollo,
      components: componentes,
      baseServings: 5,
      mealType: "LUNCH",
      members: [
        {
          profile: perfil,
          override: { ENERGY_KCAL: { minimum: null, preferred: null, maximum: 1200 } },
        },
      ],
    });
    expect(conExcepcion.servings[0]!.targets.ENERGY_KCAL?.maximum).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
describe("porciones familiares completas", () => {
  it("cinco integrantes, totales que cuadran y agrupación por método", async () => {
    const nombres = ["Ana", "Paula", "Sebastián", "Constanza", "Ricardo"];
    const perfiles: MemberNutritionProfile[] = [];
    for (const nombre of nombres) {
      const id = nombre === "Ana" ? hogarA.memberId : await miembroPorNombre(nombre);
      perfiles.push(await perfilDe(id, nombre));
    }

    const proyeccion = projectFamilyServings({
      versionId: versionPollo,
      components: await componentesDeReceta(versionPollo),
      baseServings: 5,
      mealType: "LUNCH",
      members: perfiles.map((profile) => ({ profile })),
    });

    expect(proyeccion.servings).toHaveLength(5);

    for (const total of proyeccion.totals) {
      const suma = total.perMember.reduce((s, m) => s + m.quantity, 0);
      expect(total.total).toBeCloseTo(suma, 9);
      const porMetodo = total.byMethod.reduce((s, g) => s + g.quantity, 0);
      expect(porMetodo).toBeCloseTo(total.total, 9);
    }

    // Constanza tiene alergia al pollo desde un test anterior: no aporta nada.
    const conAlergia = proyeccion.servings.find((s) => s.memberName === "Constanza")!;
    expect(conAlergia.fit).toBe("NOT_COMPATIBLE");
    const pollo = proyeccion.totals.find((t) => t.label.includes("pollo"));
    expect(pollo?.perMember.some((m) => m.memberName === "Constanza")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("aislamiento entre hogares", () => {
  it("el hogar B no ve nada de la nutrición del hogar A", async () => {
    const conteos = await h.como(USER_B, async () => ({
      objetivos: (await h.filas("select 1 from public.nutrition_goals")).length,
      preferencias: (await h.filas("select 1 from public.member_preferences")).length,
      perfiles: (await h.filas("select 1 from public.member_nutrition_profiles")).length,
      planes: (await h.filas("select 1 from public.member_daily_nutrition_plans")).length,
      integrantes: (
        await h.filas("select 1 from public.household_members where household_id = $1", [
          hogarA.householdId,
        ])
      ).length,
    }));

    expect(conteos).toEqual({
      objetivos: 0,
      preferencias: 0,
      perfiles: 0,
      planes: 0,
      integrantes: 0,
    });
  });

  it("B sí ve sus propias cosas: la prueba no pasa por estar vacía la base", async () => {
    const propios = await h.como(USER_B, () =>
      h.filas("select 1 from public.household_members where household_id = $1", [
        hogarB.householdId,
      ]),
    );
    expect(propios.length).toBeGreaterThan(0);
  });
});
