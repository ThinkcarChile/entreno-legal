import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekStart } from "@/domain/nutrition/calendar";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Hotfix final del Sprint 7 — el consumo declarado y el inventario físico son
 * dos fuentes distintas y ninguna falsifica a la otra.
 *
 * Regresión pedida por el director: demanda 1.155 g con stock 1.120 g →
 * lotes consumidos 1.120 g + shortfall 35 g = consumo declarado 1.155 g.
 */

const USER_A = "00000000-0000-0000-0000-0000000000c8";
const USER_B = "00000000-0000-0000-0000-0000000000c9";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let versionPollo: string;
let perfilA: string;
let planA: string;
let polloId: string;
let arrozId: string;
let atunId: string;

const SEMANA = weekStart("2026-10-05");
const LUNES = "2026-10-05";
const MARTES = "2026-10-06";
const MIERCOLES = "2026-10-07";
const JUEVES = "2026-10-08";

async function comidaEn(fecha: string): Promise<string> {
  return h.como(USER_A, async () => {
    const dia = (await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
      [planA, fecha],
    ))!.id;
    return (await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
       select $1, 'LUNCH', 'RECIPE', v.template_id, v.id
       from public.meal_template_versions v where v.id = $2
       returning id`,
      [dia, versionPollo],
    ))!.id;
  });
}

async function confirmar(
  asignacion: string,
  fecha: string,
  componente: Record<string, unknown>,
) {
  await h.como(USER_A, async () => {
    await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
      asignacion,
      JSON.stringify([
        {
          member_id: hogarA.memberId,
          version_id: versionPollo,
          profile_id: perfilA,
          optimizer_version: "portion-optimizer/1.0.0",
          meal_type: "LUNCH",
          serving_date: fecha,
          fit: "COMPATIBLE",
          adaptation_level: 0,
          score: 90,
          nutrition: { energy_kcal: 500 },
          completeness: { energy_kcal: "COMPLETE" },
          reasons: [],
          unmet_constraints: [],
          components: [
            {
              label: "Componente",
              base_quantity: 100,
              proposed_quantity: 100,
              unit: "G",
              weight_basis: "RAW",
              cooking_method: "BAKED",
              added_fat_g: 0,
              sort_order: 1,
              ...componente,
            },
          ],
          substitutions: [],
        },
      ]),
    ]);
  });
}

async function consumir(asignacion: string) {
  return h.como(USER_A, () =>
    h.fila<{ consume_planned_meal: { servings: number; shortfalls: { label: string; quantity: number; unit: string; weight_basis: string }[] } }>(
      "select public.consume_planned_meal($1)",
      [asignacion],
    ),
  );
}

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar Shortfall A", "Fran");
  await crearHogar(h, USER_B, "Hogar Shortfall B", "Vecino");

  versionPollo = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;
  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;
  arrozId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'arroz blanco'",
  ))!.id;
  atunId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'salmon'",
  ))!.id;

  await h.como(USER_A, async () => {
    perfilA = (await h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', 'firma-short-a', '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'shortfall')`,
      [hogarA.memberId],
    ))!.publish_nutrition_profile;
    planA = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, $2)",
      [hogarA.householdId, SEMANA],
    ))!.ensure_weekly_plan;
  });
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------
describe("REGRESIÓN del director: demanda 1.155 g, stock 1.120 g", () => {
  let asignacion: string;

  it("consume 1.120 de los lotes + shortfall 35 = consumo declarado 1.155", async () => {
    // Stock: 1.120 g de pollo crudo en dos lotes (700 + 420, FEFO por antigüedad).
    await h.como(USER_A, async () => {
      await h.db.query(
        "select public.add_manual_lot($1, 'Pollo lote 1', 700, 'G', $2, null, null, null)",
        [hogarA.householdId, polloId],
      );
      await h.db.query(
        "select public.add_manual_lot($1, 'Pollo lote 2', 420, 'G', $2, null, null, null)",
        [hogarA.householdId, polloId],
      );
    });

    asignacion = await comidaEn(LUNES);
    await confirmar(asignacion, LUNES, {
      label: "Pechuga de pollo (sin piel)",
      ingredient_id: polloId,
      proposed_quantity: 1155,
    });

    const r = await consumir(asignacion);
    const resultado = r!.consume_planned_meal;
    expect(resultado.servings).toBe(1);

    // Lotes consumidos: exactamente 1.120, jamás negativo.
    const stock = await h.como(USER_A, () =>
      h.fila<{ total: string }>(
        `select coalesce(sum(quantity), 0) as total from public.inventory_lots
         where household_id = $1 and ingredient_id = $2`,
        [hogarA.householdId, polloId],
      ),
    );
    expect(Number(stock!.total)).toBe(0);

    const movido = await h.como(USER_A, () =>
      h.fila<{ total: string }>(
        `select -sum(delta) as total from public.inventory_movements m
         join public.inventory_lots l on l.id = m.lot_id
         where l.ingredient_id = $1 and m.reason = 'CONSUMED'`,
        [polloId],
      ),
    );
    expect(Number(movido!.total)).toBe(1120);

    // shortfall = 35, con toda su identidad.
    expect(resultado.shortfalls).toHaveLength(1);
    expect(resultado.shortfalls[0]!.quantity).toBe(35);

    const fila = await h.como(USER_A, () =>
      h.fila<{
        quantity: string; unit: string; weight_basis: string; ingredient_id: string;
        assignment_id: string; projection_id: string; serving_date: string; status: string;
      }>(
        "select quantity, unit, weight_basis, ingredient_id, assignment_id, projection_id, serving_date, status from public.consumption_shortfalls where household_id = $1",
        [hogarA.householdId],
      ),
    );
    expect(Number(fila!.quantity)).toBe(35);
    expect(fila!.unit).toBe("G");
    expect(fila!.weight_basis).toBe("RAW");
    expect(fila!.ingredient_id).toBe(polloId);
    expect(fila!.assignment_id).toBe(asignacion);
    expect(fila!.projection_id).not.toBeNull();
    expect(fila!.status).toBe("OPEN");
  });

  it("el consumo DECLARADO sigue siendo 1.155: la porción congelada no se redujo", async () => {
    const declarado = await h.como(USER_A, () =>
      h.fila<{ proposed_quantity: string; status: string }>(
        `select c.proposed_quantity, p.status
         from public.member_serving_components c
         join public.member_serving_projections p on p.id = c.projection_id
         where p.assignment_id = $1`,
        [asignacion],
      ),
    );
    // Es lo que leerá el pronóstico: X, no Y.
    expect(Number(declarado!.proposed_quantity)).toBe(1155);
    expect(declarado!.status).toBe("CONSUMED");
  });

  it("K-22 con desajuste: consumir de nuevo no duplica ni el descuento ni el shortfall", async () => {
    const r = await consumir(asignacion);
    expect(r!.consume_planned_meal.servings).toBe(0);
    const filas = await h.como(USER_A, () =>
      h.filas("select 1 from public.consumption_shortfalls where assignment_id = $1", [asignacion]),
    );
    expect(filas).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("bases físicas: compatible, convertible o desajuste — jamás 1:1 inventado", () => {
  it("demanda COCIDA con lote CRUDO y rendimiento conocido: conversión explícita", async () => {
    // 280 g de arroz cocido; lote de 150 g crudos; rendimiento BOILED ×2,8.
    // Crudo necesario = 100 g → alcanza: se descuentan 100 g del lote crudo.
    await h.como(USER_A, async () => {
      await h.db.query(
        "select public.add_manual_lot($1, 'Arroz crudo', 150, 'G', $2, null, null, null)",
        [hogarA.householdId, arrozId],
      );
    });
    const asignacion = await comidaEn(MARTES);
    await confirmar(asignacion, MARTES, {
      label: "Arroz cocido",
      ingredient_id: arrozId,
      proposed_quantity: 280,
      weight_basis: "COOKED",
      cooking_method: "BOILED",
    });

    const r = await consumir(asignacion);
    expect(r!.consume_planned_meal.shortfalls).toHaveLength(0);

    const lote = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>(
        `select quantity from public.inventory_lots
         where household_id = $1 and ingredient_id = $2 and label = 'Arroz crudo'`,
        [hogarA.householdId, arrozId],
      ),
    );
    expect(Number(lote!.quantity)).toBe(50); // 150 − 280/2,8 = 150 − 100

    const nota = await h.como(USER_A, () =>
      h.fila<{ notes: string }>(
        `select m.notes from public.inventory_movements m
         join public.inventory_lots l on l.id = m.lot_id
         where l.ingredient_id = $1 and m.reason = 'CONSUMED' and m.notes is not null`,
        [arrozId],
      ),
    );
    expect(nota!.notes).toMatch(/conversión explícita/i);
  });

  it("demanda COCIDA sin rendimiento: el lote crudo NO se toca y todo es shortfall", async () => {
    // El salmón no tiene rendimiento en el seed: UNKNOWN nunca es 1:1.
    await h.como(USER_A, async () => {
      await h.db.query(
        "select public.add_manual_lot($1, 'Salmón crudo', 500, 'G', $2, null, null, null)",
        [hogarA.householdId, atunId],
      );
    });
    const asignacion = await comidaEn(MIERCOLES);
    await confirmar(asignacion, MIERCOLES, {
      label: "Salmón cocido",
      ingredient_id: atunId,
      proposed_quantity: 200,
      weight_basis: "COOKED",
      cooking_method: "BAKED",
    });

    const r = await consumir(asignacion);
    expect(r!.consume_planned_meal.shortfalls).toHaveLength(1);
    expect(r!.consume_planned_meal.shortfalls[0]!.quantity).toBe(200);
    expect(r!.consume_planned_meal.shortfalls[0]!.weight_basis).toBe("COOKED");

    const lote = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>(
        `select quantity from public.inventory_lots
         where household_id = $1 and ingredient_id = $2 and label = 'Salmón crudo'`,
        [hogarA.householdId, atunId],
      ),
    );
    expect(Number(lote!.quantity)).toBe(500); // intacto
  });

  it("un lote en UNIDADES jamás paga demanda en gramos", async () => {
    // Huevos por unidad; la demanda viene en gramos: sin equivalencia, shortfall.
    const huevoId = (await h.fila<{ id: string }>(
      "select id from public.ingredients where canonical_name = 'huevo de gallina'",
    ))!.id;
    await h.como(USER_A, async () => {
      await h.db.query(
        "select public.add_manual_lot($1, 'Huevos', 12, 'UNIT', $2, null, null, null)",
        [hogarA.householdId, huevoId],
      );
    });
    const asignacion = await comidaEn(JUEVES);
    await confirmar(asignacion, JUEVES, {
      label: "Huevo",
      ingredient_id: huevoId,
      proposed_quantity: 120,
    });

    const r = await consumir(asignacion);
    expect(r!.consume_planned_meal.shortfalls).toHaveLength(1);

    const lote = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>(
        `select quantity from public.inventory_lots
         where household_id = $1 and ingredient_id = $2`,
        [hogarA.householdId, huevoId],
      ),
    );
    expect(Number(lote!.quantity)).toBe(12); // las 12 unidades intactas
  });
});

// ---------------------------------------------------------------------------
describe("resolver el desajuste", () => {
  let shortfallId: string;

  it("se resuelve como ajuste de inventario o consumo no trazado, sellado por la base", async () => {
    shortfallId = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.consumption_shortfalls where household_id = $1 and status = 'OPEN' limit 1",
        [hogarA.householdId],
      ),
    ))!.id;

    await h.como(USER_A, async () => {
      await h.db.query("select public.resolve_shortfall($1, 'ACCEPTED_UNTRACED')", [shortfallId]);
    });

    const fila = await h.como(USER_A, () =>
      h.fila<{ status: string; resolved_by: string; resolved_at: string }>(
        "select status, resolved_by, resolved_at from public.consumption_shortfalls where id = $1",
        [shortfallId],
      ),
    );
    expect(fila!.status).toBe("ACCEPTED_UNTRACED");
    expect(fila!.resolved_by).toBe(hogarA.memberId);
    expect(fila!.resolved_at).not.toBeNull();
  });

  it("resolver dos veces se rechaza", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.resolve_shortfall($1, 'RESOLVED_ADJUSTMENT')", [shortfallId]),
      ),
    ).rejects.toThrow(/ya se resolvió/i);
  });

  it("RLS: el hogar B no ve ni resuelve los desajustes del A", async () => {
    const desdeB = await h.como(USER_B, () =>
      h.filas("select 1 from public.consumption_shortfalls where household_id = $1", [
        hogarA.householdId,
      ]),
    );
    expect(desdeB).toHaveLength(0);

    const abierto = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.consumption_shortfalls where household_id = $1 and status = 'OPEN' limit 1",
        [hogarA.householdId],
      ),
    ))!.id;
    await expect(
      h.como(USER_B, () =>
        h.db.query("select public.resolve_shortfall($1, 'ACCEPTED_UNTRACED')", [abierto]),
      ),
    ).rejects.toThrow(/no autorizado/i);
  });
});
