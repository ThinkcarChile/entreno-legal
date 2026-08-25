import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, effectiveDate, weekStart } from "@/domain/nutrition/calendar";
import { analyzeStock } from "@/domain/stock/engine";
import type { StockInput } from "@/domain/stock/types";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Integración del Sprint 8 — la costura base de datos → dominio → motor.
 *
 * Las reservas salen de porciones PLANNED reales, el consumo de porciones
 * CONSUMED reales, la merma de la vista sobre el ledger — y el motor se
 * alimenta con esas filas, no con objetos de fantasía. RLS con rol
 * authenticated, jamás superusuario.
 */

const USER_A = "00000000-0000-0000-0000-0000000000d8";
const USER_B = "00000000-0000-0000-0000-0000000000d9";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };
let versionPollo: string;
let perfilA: string;
let planA: string;
let polloId: string;
let merluzaId: string;

// Fechas relativas al hoy REAL: los movimientos del ledger llevan now(), y las
// ventanas de 30 días se miden contra la misma referencia.
// Día del HOGAR (Santiago), no el día UTC: cerca de medianoche UTC difieren,
// y el RPC mide los vencimientos en el día del hogar. Usar UTC acá hacía que
// "vencido ayer" fuera HOY para el RPC y el lote se consumiera igual.
const HOY = effectiveDate(new Date(), "America/Santiago");
const SEMANA = weekStart(addDays(HOY, 7)); // la semana que viene
const MARTES = addDays(SEMANA, 1);
const VIERNES = addDays(SEMANA, 4);

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

async function confirmar(asignacion: string, fecha: string, componente: Record<string, unknown>) {
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
          nutrition: {},
          completeness: {},
          reasons: [],
          unmet_constraints: [],
          components: [
            {
              label: "Pechuga de pollo (sin piel)",
              base_quantity: 100,
              proposed_quantity: 100,
              unit: "G",
              weight_basis: "RAW",
              cooking_method: "BAKED",
              added_fat_g: 0,
              sort_order: 1,
              ingredient_id: polloId,
              ...componente,
            },
          ],
          substitutions: [],
        },
      ]),
    ]);
  });
}

/** Construye el StockInput desde la BASE, replicando la costura del cargador. */
async function stockInputDesdeBase(): Promise<StockInput> {
  return h.como(USER_A, async () => {
    const lots = (
      await h.filas<{
        id: string; ingredient_id: string; label: string; quantity: string; unit: string;
        weight_basis: string; is_approximate: boolean; expiry_date: string | null;
        use_by: string | null; created_at: string; status: string; acquisition_value: string | null;
      }>(
        `select id, ingredient_id, label, quantity, unit, weight_basis, is_approximate,
                expiry_date, use_by, created_at::text, status, acquisition_value
         from public.inventory_lots
         where household_id = $1 and status = 'AVAILABLE' and ingredient_id is not null`,
        [hogarA.householdId],
      )
    ).map((l) => ({
      id: l.id,
      ingredientId: l.ingredient_id,
      label: l.label,
      quantity: Number(l.quantity),
      unit: l.unit as "G",
      weightBasis: l.weight_basis as "RAW",
      isApproximate: l.is_approximate,
      expiryDate: l.expiry_date,
      useBy: l.use_by,
      createdAt: l.created_at,
      status: l.status as "AVAILABLE",
      acquisitionValue: l.acquisition_value === null ? null : Number(l.acquisition_value),
    }));

    const futureDemand = (
      await h.filas<{
        projection_id: string; serving_date: string; ingredient_id: string; label: string;
        proposed_quantity: string; unit: string; weight_basis: string; cooking_method: string | null;
      }>(
        `select p.id as projection_id, p.serving_date::text, c.ingredient_id, c.label,
                c.proposed_quantity, c.unit::text as unit, c.weight_basis::text as weight_basis,
                c.cooking_method::text as cooking_method
         from public.member_serving_projections p
         join public.member_serving_components c on c.projection_id = p.id
         where p.status = 'PLANNED' and p.assignment_id is not null
           and p.serving_date >= $1 and c.ingredient_id is not null`,
        [HOY],
      )
    ).map((d) => ({
      ingredientId: d.ingredient_id,
      label: d.label,
      quantity: Number(d.proposed_quantity),
      unit: d.unit as "G",
      weightBasis: d.weight_basis as "RAW",
      cookingMethod: d.cooking_method,
      servingDate: d.serving_date,
      projectionId: d.projection_id,
    }));

    const consumption = (
      await h.filas<{
        serving_date: string; ingredient_id: string; proposed_quantity: string;
        unit: string; weight_basis: string; cooking_method: string | null;
      }>(
        `select p.serving_date::text, c.ingredient_id, c.proposed_quantity,
                c.unit::text as unit, c.weight_basis::text as weight_basis,
                c.cooking_method::text as cooking_method
         from public.member_serving_projections p
         join public.member_serving_components c on c.projection_id = p.id
         where p.status = 'CONSUMED' and c.ingredient_id is not null`,
      )
    ).map((c) => ({
      ingredientId: c.ingredient_id,
      quantity: Number(c.proposed_quantity),
      unit: c.unit as "G",
      weightBasis: c.weight_basis as "RAW",
      cookingMethod: c.cooking_method,
      date: c.serving_date,
    }));

    const waste = (
      await h.filas<{ ingredient_id: string; unit: string; quantity: string; estimated_cost: string | null; created_at: string }>(
        `select ingredient_id, unit, weight_basis::text as weight_basis, quantity, estimated_cost, created_at::text
         from public.waste_movements where household_id = $1`,
        [hogarA.householdId],
      )
    ).map((w) => ({
      ingredientId: w.ingredient_id,
      unit: w.unit as "G",
      weightBasis: (w as unknown as { weight_basis: string }).weight_basis as "RAW",
      quantity: Number(w.quantity),
      estimatedCost: w.estimated_cost === null ? null : Number(w.estimated_cost),
      date: w.created_at.slice(0, 10),
    }));

    const purchases = (
      await h.filas<{ ingredient_id: string; unit: string; quantity: string; created_at: string }>(
        `select ingredient_id, unit, weight_basis::text as weight_basis, quantity, created_at::text
         from public.purchase_movements where household_id = $1`,
        [hogarA.householdId],
      )
    ).map((p) => ({
      ingredientId: p.ingredient_id,
      unit: p.unit as "G",
      weightBasis: (p as unknown as { weight_basis: string }).weight_basis as "RAW",
      quantity: Number(p.quantity),
      date: p.created_at.slice(0, 10),
    }));

    const targets = (
      await h.filas<{
        ingredient_id: string; unit: string; minimum_quantity: string | null;
        target_quantity: string | null; target_days_of_supply: number | null;
        safety_stock: string | null; review_cycle: string | null; reorder_enabled: boolean; source: string;
      }>(
        "select ingredient_id, unit, minimum_quantity, target_quantity, target_days_of_supply, safety_stock, review_cycle, reorder_enabled, source from public.stock_targets where household_id = $1",
        [hogarA.householdId],
      )
    ).map((t) => ({
      ingredientId: t.ingredient_id,
      unit: t.unit as "G",
      minimumQuantity: t.minimum_quantity === null ? null : Number(t.minimum_quantity),
      targetQuantity: t.target_quantity === null ? null : Number(t.target_quantity),
      targetDaysOfSupply: t.target_days_of_supply,
      safetyStock: t.safety_stock === null ? null : Number(t.safety_stock),
      reviewCycle: t.review_cycle as null,
      reorderEnabled: t.reorder_enabled,
      source: t.source as "USER_DEFINED",
    }));

    const cobertura = await h.filas<{ dia: string }>(
      `select distinct serving_date::text as dia from public.member_serving_projections
       where status = 'PLANNED' and assignment_id is not null and serving_date >= $1
       order by 1`,
      [HOY],
    );

    return {
      today: HOY,
      lots,
      futureDemand,
      consumption,
      shortfalls: [],
      waste,
      purchases,
      yields: [],
      targets,
      planningCoveredDates: cobertura.map((c) => c.dia),
      ingredients: [
        { id: polloId, label: "Pechuga de pollo (sin piel)", categoryCode: "POULTRY" },
        { id: merluzaId, label: "Merluza", categoryCode: "FISH" },
      ],
    };
  });
}

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar Stock A", "Fran");
  hogarB = await crearHogar(h, USER_B, "Hogar Stock B", "Vecino");

  versionPollo = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;
  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;
  merluzaId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'merluza'",
  ))!.id;

  await h.como(USER_A, async () => {
    perfilA = (await h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', 'firma-stock-a', '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'stock')`,
      [hogarA.memberId],
    ))!.publish_nutrition_profile;
    planA = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, $2)",
      [hogarA.householdId, SEMANA],
    ))!.ensure_weekly_plan;

    // 4.500 g de pollo en el congelador (el ejemplo del director, §4 y §59).
    await h.db.query(
      "select public.add_manual_lot($1, 'Pollo congelado', 4500, 'G', $2, null, null, null)",
      [hogarA.householdId, polloId],
    );
  });
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------
describe("§4/§59 el ejemplo del director, desde filas reales", () => {
  let martes: string;
  let viernes: string;

  it("4.500 en casa, 3.200 reservados por comidas confirmadas, 1.300 libres", async () => {
    martes = await comidaEn(MARTES);
    await confirmar(martes, MARTES, { proposed_quantity: 1100 });
    viernes = await comidaEn(VIERNES);
    await confirmar(viernes, VIERNES, { proposed_quantity: 2100 });

    const items = analyzeStock(await stockInputDesdeBase());
    const pollo = items.find((i) => i.ingredientId === polloId)!;
    expect(pollo.onHand).toBe(4500);
    expect(pollo.reserved).toBe(3200);
    expect(pollo.available).toBe(1300);
  });

  it("§4 reconfirmar NO duplica la reserva: sigue siendo 3.200", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("select public.unconfirm_meal_assignment($1)", [martes]);
    });
    await confirmar(martes, MARTES, { proposed_quantity: 1100 });

    const items = analyzeStock(await stockInputDesdeBase());
    expect(items.find((i) => i.ingredientId === polloId)!.reserved).toBe(3200);
  });

  it("§59A consumir la comida: la reserva cae y el consumo aparece", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("select public.consume_planned_meal($1)", [martes]);
    });

    const input = await stockInputDesdeBase();
    const items = analyzeStock(input);
    const pollo = items.find((i) => i.ingredientId === polloId)!;
    // La porción CONSUMED salió de las reservas futuras (§4)…
    expect(pollo.reserved).toBe(2100);
    // …el stock físico bajó por FEFO (4.500 − 1.100)…
    expect(pollo.onHand).toBe(3400);
    expect(pollo.available).toBe(1300); // libre igual: comió lo reservado
    // …y el consumo declarado alimenta la historia.
    expect(input.consumption.some((c) => c.quantity === 1100)).toBe(true);
  });

  it("§45/§59E sustitución: pollo baja, merluza sube — el alimento REAL", async () => {
    // Se des-confirma el viernes y se reconfirma con merluza para esa persona.
    await h.como(USER_A, async () => {
      await h.db.query("select public.unconfirm_meal_assignment($1)", [viernes]);
    });
    await confirmar(viernes, VIERNES, {
      label: "Merluza",
      ingredient_id: merluzaId,
      proposed_quantity: 340,
    });

    const items = analyzeStock(await stockInputDesdeBase());
    const pollo = items.find((i) => i.ingredientId === polloId)!;
    const merluza = items.find((i) => i.ingredientId === merluzaId)!;
    expect(pollo.reserved).toBe(0); // el viernes ya no reserva pollo
    expect(merluza.reserved).toBe(340);
    expect(merluza.onHand).toBe(0);
    expect(merluza.confirmedShortage).toBe(340);
  });

  it("§59B merma: el impacto es una señal, no una regla de '-1 compra'", async () => {
    // Dale valor al lote para probar el costo proporcional (§26).
    await h.comoAdmin(async () => {
      await h.db.query(
        "update public.inventory_lots set acquisition_value = 10000 where household_id = $1 and ingredient_id = $2",
        [hogarA.householdId, polloId],
      );
    });
    const lote = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.inventory_lots where household_id = $1 and ingredient_id = $2 and status = 'AVAILABLE'",
        [hogarA.householdId, polloId],
      ),
    ))!.id;
    await h.como(USER_A, async () => {
      await h.db.query("select public.split_lot($1, array[400]::numeric[])", [lote]);
      const hijo = (await h.fila<{ id: string }>(
        "select id from public.inventory_lots where parent_lot_id = $1",
        [lote],
      ))!.id;
      await h.db.query("select public.discard_lot($1, 'SPOILED', null)", [hijo]);
    });

    const input = await stockInputDesdeBase();
    const items = analyzeStock(input);
    const pollo = items.find((i) => i.ingredientId === polloId)!;
    expect(pollo.waste30).toBe(400);
    // Costo proporcional: el hijo se llevó su parte del valor y la perdió entera.
    expect(pollo.wasteCost30).not.toBeNull();
    expect(pollo.wasteCost30!).toBeGreaterThan(0);
    expect(pollo.onHand).toBe(3000); // 3.400 − 400
  });

  it("§59C/§20 recibir compra: el stock sube UNA vez, sin doble conteo", async () => {
    await h.como(USER_A, async () => {
      const lista = (await h.fila<{ id: string }>(
        `insert into public.shopping_lists (household_id, plan_id, created_by, status)
         values ($1, $2, $3, 'ACTIVE') returning id`,
        [hogarA.householdId, planA, hogarA.memberId],
      ))!.id;
      await h.db.query(
        `select public.generate_shopping_revision($1, 'firma-s1', 'shopping-engine/1.0.0', '[]'::jsonb, '[]'::jsonb, $2::jsonb)`,
        [
          lista,
          JSON.stringify([
            {
              line_key: "k-pollo", ingredient_id: polloId, product_id: null,
              label: "Pechuga de pollo (sin piel)", unit: "G", required_quantity: 2000,
              purchase_basis: "RAW", cooked_quantity: null, yield_factor: null,
              unresolved: false, unresolved_reason: null, provenance: [],
            },
          ]),
        ],
      );
      await h.db.query(
        "update public.shopping_list_items set status = 'PURCHASED' where list_id = $1",
        [lista],
      );
      await h.db.query("update public.shopping_lists set status = 'COMPLETED' where id = $1", [lista]);
      await h.db.query("select public.receive_shopping_list($1, null)", [lista]);
      // Recibir DOS veces: no-op (K-22).
      await h.db.query("select public.receive_shopping_list($1, null)", [lista]);
    });

    const items = analyzeStock(await stockInputDesdeBase());
    const pollo = items.find((i) => i.ingredientId === polloId)!;
    // 3.000 + 2.000 recibidos UNA vez. La lista comprada NO suma aparte (§20):
    // desde la recepción, la fuente es el inventario.
    expect(pollo.onHand).toBe(5000);
    // Compras del período: el alta manual (4.500, causa PURCHASE) + la
    // recepción (2.000). El SPLIT no es compra y no infla la señal.
    expect(pollo.purchases30).toBe(6500);
  });
});

// ---------------------------------------------------------------------------
describe("stock_targets: RPC, RLS y ámbito", () => {
  it("crear y actualizar el objetivo, siempre USER_DEFINED", async () => {
    await h.como(USER_A, async () => {
      await h.db.query(
        "select public.set_stock_target($1, $2, 'G', 2000, 5000, null, null, 'MONTHLY', true)",
        [hogarA.householdId, polloId],
      );
      await h.db.query(
        "select public.set_stock_target($1, $2, 'G', 1500, 5000, null, null, 'MONTHLY', true)",
        [hogarA.householdId, polloId],
      );
    });
    const filas = await h.como(USER_A, () =>
      h.filas<{ minimum_quantity: string; source: string }>(
        "select minimum_quantity, source from public.stock_targets where household_id = $1",
        [hogarA.householdId],
      ),
    );
    expect(filas).toHaveLength(1); // upsert, no duplicado
    expect(Number(filas[0]!.minimum_quantity)).toBe(1500);
    expect(filas[0]!.source).toBe("USER_DEFINED");
  });

  it("RLS: el hogar B no lee los objetivos del A", async () => {
    const desdeB = await h.como(USER_B, () =>
      h.filas("select 1 from public.stock_targets where household_id = $1", [hogarA.householdId]),
    );
    expect(desdeB).toHaveLength(0);
  });

  it("el hogar B no puede fijar objetivos en el hogar A ni con alimentos privados de A", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query(
          "select public.set_stock_target($1, $2, 'G', 1, null, null, null, null, true)",
          [hogarA.householdId, polloId],
        ),
      ),
    ).rejects.toThrow(/no autorizado/i);

    const privadoA = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `insert into public.ingredients (canonical_name, display_name, category_id, household_id)
         values ('tesoro de fran', 'Tesoro de Fran',
                 (select id from public.ingredient_categories where code = 'OTHER'), $1)
         returning id`,
        [hogarA.householdId],
      ),
    ))!.id;
    await expect(
      h.como(USER_B, () =>
        h.db.query(
          "select public.set_stock_target($1, $2, 'G', 1, null, null, null, null, true)",
          [hogarB.householdId, privadoA],
        ),
      ),
    ).rejects.toThrow(/no pertenece/i);
  });

  it("NaN rechazado también acá", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query(
          "select public.set_stock_target($1, $2, 'G', 'NaN'::numeric, null, null, null, null, true)",
          [hogarA.householdId, polloId],
        ),
      ),
    ).rejects.toThrow(/válido/i);
  });
});

// ---------------------------------------------------------------------------
describe("vistas de merma y compra: RLS por security_invoker", () => {
  it("el hogar B no ve mermas ni compras del A", async () => {
    const mermas = await h.como(USER_B, () =>
      h.filas("select 1 from public.waste_movements where household_id = $1", [hogarA.householdId]),
    );
    expect(mermas).toHaveLength(0);
    const compras = await h.como(USER_B, () =>
      h.filas("select 1 from public.purchase_movements where household_id = $1", [
        hogarA.householdId,
      ]),
    );
    expect(compras).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("lotes vencidos: la MISMA regla en el motor y en el consumo físico", () => {
  it("consumir NO toca un lote vencido: el faltante cae como shortfall", async () => {
    const ayer = addDays(HOY, -1);
    const manana = addDays(HOY, 1);
    // Lote vencido de 500 g + lote fresco de 100 g.
    await h.como(USER_A, async () => {
      await h.db.query(
        "select public.add_manual_lot($1, 'Merluza vencida', 500, 'G', $2, null, $3, null)",
        [hogarA.householdId, merluzaId, ayer],
      );
      await h.db.query(
        "select public.add_manual_lot($1, 'Merluza fresca', 100, 'G', $2, null, $3, null)",
        [hogarA.householdId, merluzaId, manana],
      );
    });

    const comida = await comidaEn(addDays(SEMANA, 5));
    await confirmar(comida, addDays(SEMANA, 5), {
      label: "Merluza",
      ingredient_id: merluzaId,
      proposed_quantity: 300,
    });
    const r = await h.como(USER_A, () =>
      h.fila<{ consume_planned_meal: { shortfalls: { quantity: number }[] } }>(
        "select public.consume_planned_meal($1)",
        [comida],
      ),
    );

    // FEFO consumió el FRESCO (100 g) y el resto es shortfall (200 g): el
    // vencido quedó intacto, esperando su descarte con causa EXPIRED.
    const vencido = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>(
        "select quantity from public.inventory_lots where household_id = $1 and label = 'Merluza vencida'",
        [hogarA.householdId],
      ),
    );
    expect(Number(vencido!.quantity)).toBe(500);
    const fresco = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>(
        "select quantity from public.inventory_lots where household_id = $1 and label = 'Merluza fresca'",
        [hogarA.householdId],
      ),
    );
    expect(Number(fresco!.quantity)).toBe(0);
    expect(r!.consume_planned_meal.shortfalls).toHaveLength(1);
    expect(r!.consume_planned_meal.shortfalls[0]!.quantity).toBe(200);
  });
});
