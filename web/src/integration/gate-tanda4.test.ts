import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * REGRESIONES DE LA TANDA 4 (migración 0021 + motores).
 *
 * [S-2] la sugerencia de Stock Intelligence conserva su base física: RAW y
 *       DRAINED del mismo alimento son DOS líneas, y el neteo con Procurement
 *       calza por alimento::unidad::base.
 * [P-1] aprobar una orden revalida TAMBIÉN lo pendiente en la lista, no solo
 *       lo en camino: una pestaña vieja recibe "recarga", no una orden doble.
 */

const USER = "00000000-0000-0000-0000-0000000ac001";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let polloId: string;
let listaId: string;

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER, "Tanda4", "Carla");
  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;

  await h.como(USER, async () => {
    const plan = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, (date_trunc('week', current_date))::date)",
      [hogar.householdId],
    ))!.ensure_weekly_plan;
    listaId = (await h.fila<{ id: string }>(
      `insert into public.shopping_lists (household_id, plan_id, status)
       values ($1, $2, 'ACTIVE') returning id`,
      [hogar.householdId, plan],
    ))!.id;
  });
});

afterAll(async () => {
  await h?.cerrar();
});

describe("[S-2] la sugerencia lleva su base física", () => {
  it("RAW y DRAINED del mismo alimento conviven como dos líneas", async () => {
    await h.como(USER, async () => {
      await h.db.query(
        `insert into public.shopping_list_items
           (list_id, source, ingredient_id, label, unit, planned_quantity, purchase_basis)
         values ($1, 'STOCK_INTELLIGENCE', $2, 'Pollo crudo', 'G', 500, 'RAW')`,
        [listaId, polloId],
      );
      await h.db.query(
        `insert into public.shopping_list_items
           (list_id, source, ingredient_id, label, unit, planned_quantity, purchase_basis)
         values ($1, 'STOCK_INTELLIGENCE', $2, 'Pollo escurrido', 'G', 240, 'DRAINED')`,
        [listaId, polloId],
      );
      const filas = await h.filas<{ purchase_basis: string }>(
        `select purchase_basis::text from public.shopping_list_items
         where list_id = $1 and source = 'STOCK_INTELLIGENCE' and ingredient_id = $2
         order by purchase_basis`,
        [listaId, polloId],
      );
      expect(filas.map((f) => f.purchase_basis)).toEqual(["DRAINED", "RAW"]);
    });
  });

  it("la MISMA base sigue siendo única: el duplicado rebota", async () => {
    await h.como(USER, async () => {
      await expect(
        h.db.query(
          `insert into public.shopping_list_items
             (list_id, source, ingredient_id, label, unit, planned_quantity, purchase_basis)
           values ($1, 'STOCK_INTELLIGENCE', $2, 'Pollo crudo bis', 'G', 100, 'RAW')`,
          [listaId, polloId],
        ),
      ).rejects.toThrow(/duplicate key|shopping_items_suggestion_uniq/);
    });
  });
});

describe("[P-1] aprobar revalida lo pendiente en la lista", () => {
  const itemBase = (extra: Record<string, unknown>) => ({
    ingredient_id: polloId,
    supplier_product_id: null,
    label: "Pechuga de pollo",
    required_quantity: 1000,
    suggested_quantity: 1000,
    unit: "G",
    weight_basis: "RAW",
    package_count: null,
    provenance: [],
    ...extra,
  });

  it("con la lista cambiada respecto de lo que vio la pantalla: rechaza con 'recarga'", async () => {
    await h.como(USER, async () => {
      // La pantalla vieja vio 0 pendiente, pero la lista tiene 500 g RAW vivos.
      await expect(
        h.db.query(
          "select public.create_procurement_order($1, null, current_date, null, $2, 'purchase-schedule/1.0.0', $3::jsonb)",
          [
            hogar.householdId,
            `PO-TEST-VIEJO-${polloId}`,
            JSON.stringify([itemBase({ known_pending_in_list: 0 })]),
          ],
        ),
      ).rejects.toThrow(/la lista de compras cambió/);
    });
  });

  it("con el neteo al día: la orden se crea", async () => {
    await h.como(USER, async () => {
      // Vivo: 500 RAW pendientes (la línea DRAINED de 240 NO cuenta en RAW).
      const r = await h.fila<{ create_procurement_order: string }>(
        "select public.create_procurement_order($1, null, current_date, null, $2, 'purchase-schedule/1.0.0', $3::jsonb)",
        [
          hogar.householdId,
          `PO-TEST-VIVO-${polloId}`,
          JSON.stringify([itemBase({ known_pending_in_list: 500 })]),
        ],
      );
      expect(r!.create_procurement_order).toBeTruthy();
    });
  });

  it("sin dedupe_key NO hay orden: la idempotencia es obligatoria (0025)", async () => {
    await h.como(USER, async () => {
      await expect(
        h.db.query(
          "select public.create_procurement_order($1, null, current_date, null, null, 'v', $2::jsonb)",
          [hogar.householdId, JSON.stringify([itemBase({})])],
        ),
      ).rejects.toThrow(/clave de idempotencia/);
    });
  });

  it("la guarda vieja de known_incoming sigue viva (no se cambió una por otra)", async () => {
    await h.como(USER, async () => {
      // Ahora HAY una orden en camino con 1000 g: known_incoming 0 está viejo.
      await expect(
        h.db.query(
          "select public.create_procurement_order($1, null, current_date, null, $2, 'purchase-schedule/1.0.0', $3::jsonb)",
          [
            hogar.householdId,
            `PO-TEST-INCOMING-${polloId}`,
            JSON.stringify([itemBase({ known_incoming: 0 })]),
          ],
        ),
      ).rejects.toThrow(/otra orden en camino/);
    });
  });
});
