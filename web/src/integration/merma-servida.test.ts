import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekStart } from "@/domain/nutrition/calendar";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 12 — ALTO 3: la merma de lo servido tiene que PESAR en el informe.
 *
 * La comida que se sirve y se bota se anota con `delta` 0 a proposito: esos
 * gramos ya salieron de la despensa al servir, y restarlos otra vez seria doble
 * descuento. Pero `waste_movements` sumaba por `delta`, asi que la merma del
 * plato — la mas frecuente de una casa — valia cero en el informe de
 * desperdicio. Se botaba comida y el numero decia cero.
 *
 * Estas regresiones fijan las dos mitades a la vez, que es lo dificil:
 * el informe la VE, y el inventario NO la descuenta dos veces.
 */

const USER = "00000000-0000-0000-0000-0000000000f1";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let polloId: string;
let arrozId: string;
let asignacion: string;
let renglonPollo: string;
let renglonArroz: string;
let lotePollo: string;
let loteArroz: string;

const SEMANA = weekStart("2026-09-28");
const LUNES = "2026-09-28";

/** El valor de compra del lote de pollo: 1000 g costaron $5.000. */
const VALOR_POLLO = 5000;

async function lote(
  ingrediente: string,
  etiqueta: string,
  cantidad: number,
  valor: number | null,
): Promise<string> {
  return h.comoAdmin(async () => {
    const id = (await h.fila<{ id: string }>(
      `insert into public.inventory_lots
         (household_id, ingredient_id, label, unit, quantity, weight_basis, status,
          acquisition_value)
       values ($1, $2, $3, 'G', 0, 'RAW', 'AVAILABLE', $4)
       returning id`,
      [hogar.householdId, ingrediente, etiqueta, valor],
    ))!.id;
    await h.db.query(
      `insert into public.inventory_movements (household_id, lot_id, reason, delta)
       values ($1, $2, 'PURCHASE', $3)`,
      [hogar.householdId, id, cantidad],
    );
    return id;
  });
}

async function cantidadDeLote(id: string): Promise<number> {
  const fila = await h.como(USER, () =>
    h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [id]),
  );
  return Number(fila!.quantity);
}

interface FilaMerma {
  quantity: string;
  weight_basis: string;
  waste_kind: string;
  estimated_cost: string | null;
}

async function merma(ingrediente: string): Promise<FilaMerma[]> {
  return h.como(USER, () =>
    h.filas<FilaMerma>(
      `select quantity, weight_basis, waste_kind, estimated_cost
       from public.waste_movements
       where household_id = $1 and ingredient_id = $2
       order by created_at, quantity desc`,
      [hogar.householdId, ingrediente],
    ),
  );
}

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER, "Hogar merma", "Fran");

  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;
  arrozId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'arroz blanco'",
  ))!.id;

  const version = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;

  await h.como(USER, async () => {
    const perfil = (await h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', 'firma-merma', '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'merma')`,
      [hogar.memberId],
    ))!.publish_nutrition_profile;

    const plan = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, $2)",
      [hogar.householdId, SEMANA],
    ))!.ensure_weekly_plan;

    const dia = (await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
      [plan, LUNES],
    ))!.id;

    asignacion = (await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
       select $1, 'LUNCH', 'RECIPE', v.template_id, v.id
       from public.meal_template_versions v where v.id = $2
       returning id`,
      [dia, version],
    ))!.id;

    await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
      asignacion,
      JSON.stringify([
        {
          member_id: hogar.memberId,
          version_id: version,
          profile_id: perfil,
          optimizer_version: "portion-optimizer/1.0.0",
          meal_type: "LUNCH",
          serving_date: LUNES,
          fit: "COMPATIBLE",
          adaptation_level: 0,
          score: 90,
          nutrition: { energy_kcal: 700 },
          completeness: { energy_kcal: "COMPLETE" },
          reasons: [],
          unmet_constraints: [],
          unverifiable_constraints: [],
          components: [
            {
              label: "Pechuga de pollo (sin piel)",
              base_quantity: 200,
              proposed_quantity: 200,
              unit: "G",
              weight_basis: "RAW",
              cooking_method: "BAKED",
              added_fat_g: 0,
              sort_order: 1,
              ingredient_id: polloId,
            },
            // COCIDO contra una despensa que solo tiene arroz CRUDO: el
            // descuento pasa por la conversion explicita (factor 2,8 del seed)
            // y por eso el renglon y el lote hablan lenguas distintas.
            {
              label: "Arroz blanco",
              base_quantity: 280,
              proposed_quantity: 280,
              unit: "G",
              weight_basis: "COOKED",
              cooking_method: "BOILED",
              added_fat_g: 0,
              sort_order: 2,
              ingredient_id: arrozId,
            },
          ],
          substitutions: [],
        },
      ]),
    ]);
  });

  lotePollo = await lote(polloId, "Pechuga de pollo (sin piel)", 1000, VALOR_POLLO);
  loteArroz = await lote(arrozId, "Arroz blanco", 1000, null);

  await h.como(USER, async () => {
    await h.db.query("select public.serve_meal_assignment($1)", [asignacion]);
  });

  const renglones = await h.como(USER, () =>
    h.filas<{ id: string; label: string }>(
      `select i.id, i.label from public.meal_serving_record_items i
       join public.meal_serving_records r on r.id = i.record_id
       where r.assignment_id = $1`,
      [asignacion],
    ),
  );
  renglonPollo = renglones.find((r) => r.label.startsWith("Pechuga"))!.id;
  renglonArroz = renglones.find((r) => r.label.startsWith("Arroz"))!.id;
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------
describe("ALTO 3 — se boto del plato: el informe de desperdicio lo ve", () => {
  it("antes de botar, el informe esta vacio (y el lote pago los 200 al servir)", async () => {
    expect(await merma(polloId)).toHaveLength(0);
    expect(await cantidadDeLote(lotePollo)).toBe(800);
  });

  it("botar 50 g del plato aparece como merma SERVING, con su costo", async () => {
    await h.como(USER, async () => {
      await h.db.query("select public.discard_serving($1, $2, $3)", [
        renglonPollo,
        50,
        "quedo en el plato",
      ]);
    });

    const filas = await merma(polloId);
    expect(filas).toHaveLength(1);
    expect(Number(filas[0]!.quantity)).toBe(50);
    expect(filas[0]!.waste_kind).toBe("SERVING");
    // EL COSTO DE LA MERMA DEL PLATO ES DESCONOCIDO, Y ESO SE DECLARA.
    //
    // Este test pedia $250 (= $5.000 × 50/1000) y lo sacaba de la estimacion
    // vieja de la 0036 (`acquisition_value × cantidad / entradas`), un segundo
    // modelo contable que divergia del devengo. La 0048 mato a ese escritor:
    // `estimated_cost` ahora LEE `cost_allocations`.
    //
    // Y el plato no tiene devengo propio: `discard_serving` escribe un
    // movimiento con delta 0 —la comida ya salio de la despensa al SERVIR, y ahi
    // se cobro entera como CONSUMED—, asi que costear otra vez esos 50 g contra
    // el lote lo dejaria cobrado dos veces y `verify_lot_cost_invariant` lo
    // reportaria descuadrado. Lo que falta es RECLASIFICAR parte de un consumo ya
    // cobrado a merma, que necesita una categoria con signo negativo que el enum
    // todavia no tiene.
    //
    // Mientras tanto: NULL. Desconocido, no cero. Un $0 aca seria «no se boto
    // plata», que es exactamente la mentira que el sprint existe para impedir.
    expect(filas[0]!.estimated_cost).toBeNull();
  });

  it("y el inventario NO se descuenta dos veces: el lote sigue en 800", async () => {
    expect(await cantidadDeLote(lotePollo)).toBe(800);
    const movs = await h.como(USER, () =>
      h.filas<{ delta: string }>(
        `select delta from public.inventory_movements
         where lot_id = $1 and reason = 'DISCARDED_LEFTOVER'`,
        [lotePollo],
      ),
    );
    expect(movs).toHaveLength(1);
    expect(Number(movs[0]!.delta)).toBe(0);
  });

  it("la merma de la despensa y la del plato se SUMAN en la misma columna", async () => {
    // Un segundo lote de pollo que se echa a perder entero: 60 g que salen de
    // la despensa de verdad. El informe del alimento tiene que decir 110.
    const podrido = await lote(polloId, "Pechuga de pollo (sin piel)", 60, null);
    await h.como(USER, async () => {
      await h.db.query("select public.discard_lot($1, 'SPOILED', $2)", [podrido, "se echo a perder"]);
    });

    const filas = await merma(polloId);
    const total = filas.reduce((acc, f) => acc + Number(f.quantity), 0);
    expect(total).toBe(110);
    expect(filas.map((f) => f.waste_kind).sort()).toEqual(["INVENTORY", "SERVING"]);
    // El costo del lote sin valor de compra es DESCONOCIDO, no cero: el motor
    // ve un NULL y devuelve NULL para el total (§26).
    expect(filas.some((f) => f.estimated_cost === null)).toBe(true);
  });

  it("anular la merma la resta del informe sin borrar la historia", async () => {
    await h.como(USER, async () => {
      await h.db.query("select public.undo_discard_serving($1, $2, $3)", [
        renglonPollo,
        50,
        "estaba mal declarada",
      ]);
    });

    const filas = (await merma(polloId)).filter((f) => f.waste_kind === "SERVING");
    // Dos filas, no cero: la merma original sigue escrita y la anulacion es una
    // fila mas, con el signo al reves. El neto de la ventana es lo que cuenta.
    expect(filas).toHaveLength(2);
    expect(filas.reduce((acc, f) => acc + Number(f.quantity), 0)).toBe(0);
    expect(await cantidadDeLote(lotePollo)).toBe(800);
  });
});

// ---------------------------------------------------------------------------
describe("ALTO 3 — la merma se pesa en la lengua del LOTE, no en la del plato", () => {
  it("140 g de arroz COCIDO botados pesan 50 g CRUDOS en el informe", async () => {
    // El renglon sirvio 280 g cocidos que salieron de 100 g crudos (factor 2,8).
    // Botar la mitad del plato son 50 g crudos de despensa perdida: contar 140
    // seria sumar gramos cocidos con gramos crudos en la misma columna.
    expect(await cantidadDeLote(loteArroz)).toBe(900);

    await h.como(USER, async () => {
      await h.db.query("select public.discard_serving($1, $2, $3)", [
        renglonArroz,
        140,
        "sobro arroz en el plato",
      ]);
    });

    const filas = await merma(arrozId);
    expect(filas).toHaveLength(1);
    expect(Number(filas[0]!.quantity)).toBe(50);
    expect(filas[0]!.weight_basis).toBe("RAW");
    expect(await cantidadDeLote(loteArroz)).toBe(900);
  });

  it("anular esa merma la deja en cero exacto, no en -90", async () => {
    await h.como(USER, async () => {
      await h.db.query("select public.undo_discard_serving($1, $2)", [renglonArroz, 140]);
    });

    const filas = await merma(arrozId);
    expect(filas.reduce((acc, f) => acc + Number(f.quantity), 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("ALTO 3 — la pared: una merma servida sin peso no se puede escribir", () => {
  it("un DISCARDED_LEFTOVER con cobertura y sin waste_lot_quantity rebota", async () => {
    // Es el defecto original con nombre y apellido: si un escritor futuro se
    // olvida de la columna, la merma vuelve a ser invisible. El CHECK lo impide
    // antes de tocar disco.
    await expect(
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, serving_record_item_id, covers_quantity)
           values ($1, $2, 'DISCARDED_LEFTOVER', 0, $3, -10)`,
          [hogar.householdId, lotePollo, renglonPollo],
        ),
      ),
    ).rejects.toThrow(/movements_waste_lot_qty_shape/);
  });

  it("y una merma de despensa NO puede llevar peso de merma servida", async () => {
    await expect(
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, waste_lot_quantity)
           values ($1, $2, 'SPOILED', -10, -10)`,
          [hogar.householdId, lotePollo],
        ),
      ),
    ).rejects.toThrow(/movements_waste_lot_qty_shape/);
  });
});
