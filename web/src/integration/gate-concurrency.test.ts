import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * CONCURRENCIA Y OUTBOX (Integration Gate §39 y §40).
 *
 * Dos personas de la misma familia tocan el mismo botón a la vez. Cada
 * operación con efecto FÍSICO debe ocurrir exactamente una vez: el segundo
 * intento devuelve lo ya registrado o falla, pero jamás duplica materia.
 *
 * Las llamadas van en paralelo de verdad (Promise.all sobre la misma conexión
 * PGlite, que las serializa como haría PostgreSQL con dos sesiones).
 */

const USER = "00000000-0000-0000-0000-00000000cc01";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let polloId: string;
let plan: string;
let asignacion: string;
let perfil: string;
let versionPollo: string;

/** Ejecuta dos veces la misma llamada y devuelve ambos resultados. */
async function dobleSubmit<T>(fn: () => Promise<T>): Promise<[PromiseSettledResult<T>, PromiseSettledResult<T>]> {
  const [a, b] = await Promise.allSettled([fn(), fn()]);
  return [a, b];
}

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER, "Hogar Concurrencia", "Fran");
  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;
  versionPollo = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;

  await h.como(USER, async () => {
    await h.db.query("select public.ensure_storage_locations($1)", [hogar.householdId]);
    perfil = (await h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', 'firma-conc', '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'conc')`,
      [hogar.memberId],
    ))!.publish_nutrition_profile;
    plan = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, (date_trunc('week', current_date))::date)",
      [hogar.householdId],
    ))!.ensure_weekly_plan;
    const dia = (await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 order by plan_date limit 1",
      [plan],
    ))!.id;
    asignacion = (await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
       select $1, 'LUNCH', 'RECIPE', v.template_id, v.id
       from public.meal_template_versions v where v.id = $2 returning id`,
      [dia, versionPollo],
    ))!.id;
  });
}, 120000);

afterAll(async () => {
  await h?.cerrar();
});

function porciones(fecha: string) {
  return JSON.stringify([
    {
      member_id: hogar.memberId,
      version_id: versionPollo,
      profile_id: perfil,
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
          label: "Pechuga de pollo",
          base_quantity: 200,
          proposed_quantity: 200,
          unit: "G",
          weight_basis: "RAW",
          cooking_method: "BAKED",
          added_fat_g: 0,
          sort_order: 1,
          ingredient_id: polloId,
        },
      ],
      substitutions: [],
    },
  ]);
}

describe("§39 — doble submit: un solo efecto físico", () => {
  it("doble CONFIRM de la misma comida deja UNA porción por participante", async () => {
    const fecha = (await h.fila<{ d: string }>(
      "select plan_date::text as d from public.weekly_plan_days where id = (select day_id from public.meal_assignments where id = $1)",
      [asignacion],
    ))!.d;
    await dobleSubmit(() =>
      h.como(USER, () =>
        h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [asignacion, porciones(fecha)]),
      ),
    );
    const n = await h.como(USER, () =>
      h.filas("select id from public.member_serving_projections where assignment_id = $1", [asignacion]),
    );
    expect(n).toHaveLength(1);
  });

  it("doble ALTA de lote no duplica el movimiento de compra", async () => {
    // add_manual_lot NO es idempotente por diseño (cada alta es un lote real):
    // lo que se verifica es que cada llamada produzca exactamente UN lote con
    // UN movimiento, sin efectos cruzados.
    const [r1, r2] = await dobleSubmit(() =>
      h.como(USER, async () =>
        (await h.fila<{ add_manual_lot: string }>(
          "select public.add_manual_lot($1, 'Pollo conc', 500, 'G', $2)",
          [hogar.householdId, polloId],
        ))!.add_manual_lot,
      ),
    );
    const ids = [r1, r2].filter((x) => x.status === "fulfilled").map((x) => (x as PromiseFulfilledResult<string>).value);
    expect(ids.length).toBe(2);
    for (const id of ids) {
      const movs = await h.como(USER, () =>
        h.filas("select id from public.inventory_movements where lot_id = $1", [id]),
      );
      expect(movs).toHaveLength(1);
    }
  });

  it("doble SPLIT del mismo lote no parte dos veces (el segundo no encuentra cantidad)", async () => {
    const lote = await h.como(USER, async () =>
      (await h.fila<{ add_manual_lot: string }>(
        "select public.add_manual_lot($1, 'Pollo split', 1000, 'G', $2)",
        [hogar.householdId, polloId],
      ))!.add_manual_lot,
    );
    const [r1, r2] = await dobleSubmit(() =>
      h.como(USER, () => h.db.query("select public.split_lot($1, array[600, 400]::numeric[])", [lote])),
    );
    const exitos = [r1, r2].filter((x) => x.status === "fulfilled").length;
    const hijos = await h.como(USER, () =>
      h.filas<{ quantity: string }>(
        "select quantity::text from public.inventory_lots where parent_lot_id = $1",
        [lote],
      ),
    );
    // Uno de los dos parte; el otro se encuentra el lote en 0 y falla.
    expect(exitos).toBeGreaterThanOrEqual(1);
    expect(hijos).toHaveLength(2);
    expect(hijos.reduce((a, x) => a + Number(x.quantity), 0)).toBe(1000);
  });

  it("doble CONSUMO de la misma comida descuenta una sola vez", async () => {
    const fecha = (await h.fila<{ d: string }>(
      "select plan_date::text as d from public.weekly_plan_days where id = (select day_id from public.meal_assignments where id = $1)",
      [asignacion],
    ))!.d;
    await h.como(USER, () =>
      h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [asignacion, porciones(fecha)]),
    );
    await h.como(USER, () =>
      h.db.query("select public.add_manual_lot($1, 'Pollo consumo', 1000, 'G', $2)", [
        hogar.householdId,
        polloId,
      ]),
    );
    // FEFO puede tomar de cualquier lote del alimento: lo que importa es el
    // TOTAL en la despensa, que debe bajar exactamente una vez.
    const total = async () =>
      Number(
        (await h.como(USER, () =>
          h.fila<{ s: string }>(
            "select coalesce(sum(quantity), 0)::text as s from public.inventory_lots where household_id = $1 and ingredient_id = $2 and status = 'AVAILABLE'",
            [hogar.householdId, polloId],
          ),
        ))!.s,
      );
    const antes = await total();

    await dobleSubmit(() =>
      h.como(USER, () => h.db.query("select public.consume_planned_meal($1)", [asignacion])),
    );

    // 200 g de UNA porción, una sola vez. Jamás 400.
    expect(antes - (await total())).toBe(200);
    const consumidas = await h.como(USER, () =>
      h.filas(
        "select id from public.member_serving_projections where assignment_id = $1 and status = 'CONSUMED'",
        [asignacion],
      ),
    );
    expect(consumidas).toHaveLength(1);
  });

  it("doble APROBACIÓN de la misma orden crea UNA orden", async () => {
    const proveedor = await h.como(USER, async () =>
      (await h.fila<{ id: string }>(
        "insert into public.suppliers (household_id, name) values ($1, 'Prov conc') returning id",
        [hogar.householdId],
      ))!.id,
    );
    const items = JSON.stringify([
      { ingredient_id: polloId, label: "Pollo", required_quantity: 500, suggested_quantity: 500, unit: "G" },
    ]);
    const [r1, r2] = await dobleSubmit(() =>
      h.como(USER, async () =>
        (await h.fila<{ create_procurement_order: string }>(
          "select public.create_procurement_order($1, $2, null, null, 'CONC:1', 'v', $3::jsonb)",
          [hogar.householdId, proveedor, items],
        ))!.create_procurement_order,
      ),
    );
    const ids = new Set(
      [r1, r2].filter((x) => x.status === "fulfilled").map((x) => (x as PromiseFulfilledResult<string>).value),
    );
    expect(ids.size).toBe(1);
    const ordenes = await h.como(USER, () =>
      h.filas("select id from public.procurement_orders where dedupe_key = 'CONC:1'"),
    );
    expect(ordenes).toHaveLength(1);
  });

  it("doble RECEPCIÓN de la misma orden crea los lotes una sola vez", async () => {
    const proveedor = await h.como(USER, async () =>
      (await h.fila<{ id: string }>(
        "insert into public.suppliers (household_id, name) values ($1, 'Prov recibo') returning id",
        [hogar.householdId],
      ))!.id,
    );
    const orden = await h.como(USER, async () =>
      (await h.fila<{ create_procurement_order: string }>(
        "select public.create_procurement_order($1, $2, null, null, 'CONC:2', 'v', $3::jsonb)",
        [
          hogar.householdId,
          proveedor,
          JSON.stringify([
            { ingredient_id: polloId, label: "Pollo recibo", required_quantity: 700, suggested_quantity: 700, unit: "G" },
          ]),
        ],
      ))!.create_procurement_order,
    );
    await h.como(USER, () => h.db.query("select public.advance_procurement_order($1, 'ORDERED')", [orden]));
    await dobleSubmit(() =>
      h.como(USER, () => h.db.query("select public.receive_procurement_order($1)", [orden])),
    );
    const lotes = await h.como(USER, () =>
      h.filas("select id from public.inventory_lots where label = 'Pollo recibo'"),
    );
    expect(lotes).toHaveLength(1);
  });

  it("doble REGENERACIÓN de la lista no crea dos revisiones con el mismo número", async () => {
    await h.como(USER, () =>
      h.db.query(
        "insert into public.shopping_lists (household_id, plan_id, status) values ($1, $2, 'ACTIVE') on conflict do nothing",
        [hogar.householdId, plan],
      ),
    );
    const lista = (await h.como(USER, () =>
      h.fila<{ id: string }>("select id from public.shopping_lists where plan_id = $1", [plan]),
    ))!.id;
    await dobleSubmit(() =>
      h.como(USER, () =>
        h.db.query(
          "select public.generate_shopping_revision($1, 'firma-conc', 'motor/1.0', '[]'::jsonb, '{}'::jsonb, $2::jsonb)",
          [
            lista,
            JSON.stringify([
              { line_key: "k1", ingredient_id: polloId, label: "Pollo", unit: "G", required_quantity: 100,
                purchase_basis: "RAW", provenance: [] },
            ]),
          ],
        ),
      ),
    );
    const revs = await h.como(USER, () =>
      h.filas<{ revision_number: number }>(
        "select revision_number from public.shopping_list_revisions where list_id = $1",
        [lista],
      ),
    );
    const numeros = revs.map((r) => r.revision_number);
    expect(new Set(numeros).size).toBe(numeros.length); // sin números repetidos
  });
});

describe("§40 — outbox sin duplicados funcionales", () => {
  it("las claves de dedupe son únicas y estables", async () => {
    const eventos = await h.comoAdmin(() =>
      h.filas<{ dedupe_key: string; event_type: string }>(
        "select dedupe_key, event_type from public.domain_events where household_id = $1",
        [hogar.householdId],
      ),
    );
    const claves = eventos.map((e) => e.dedupe_key);
    expect(new Set(claves).size).toBe(claves.length);
  });

  it("reintentar una operación no agrega un evento equivalente", async () => {
    const lote = await h.como(USER, async () =>
      (await h.fila<{ add_manual_lot: string }>(
        "select public.add_manual_lot($1, 'Pollo evento', 300, 'G', $2)",
        [hogar.householdId, polloId],
      ))!.add_manual_lot,
    );
    const freezer = (await h.como(USER, () =>
      h.fila<{ id: string }>(
        "select id from public.storage_locations where household_id = $1 and kind = 'FREEZER' limit 1",
        [hogar.householdId],
      ),
    ))!.id;
    await h.como(USER, () => h.db.query("select public.move_lot($1, $2)", [lote, freezer]));
    const antes = (await h.comoAdmin(() =>
      h.filas("select id from public.domain_events where event_type = 'LOT_FROZEN'"),
    )).length;
    // Mover otra vez al MISMO congelador: ya está congelado, no hay evento nuevo.
    await h.como(USER, () => h.db.query("select public.move_lot($1, $2)", [lote, freezer]));
    const despues = (await h.comoAdmin(() =>
      h.filas("select id from public.domain_events where event_type = 'LOT_FROZEN'"),
    )).length;
    expect(despues).toBe(antes);
  });
});
