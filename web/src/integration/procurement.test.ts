import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Integración del Sprint 9 — Procurement sobre PostgreSQL real (PGlite),
 * migraciones 0001→0014, rol authenticated con RLS. Cubre la mitad §25 que
 * vive en la base: ámbito por hogar, inyección de UUID en SECURITY DEFINER,
 * idempotencia de la aceptación, máquina de estados y recepción por el MISMO
 * libro mayor del Sprint 7.
 */

const USER_A = "00000000-0000-0000-0000-0000000000e1";
const USER_B = "00000000-0000-0000-0000-0000000000e2";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };
let polloId: string;
let privadoB: string;
let proveedorA: string;
let presentacionA: string;

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar Proc A", "Fran");
  hogarB = await crearHogar(h, USER_B, "Hogar Proc B", "Vecino");

  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;

  // Alimento PRIVADO del hogar B, para probar el ámbito.
  privadoB = await h.comoAdmin(async () => {
    return (await h.fila<{ id: string }>(
      `insert into public.ingredients (household_id, canonical_name, display_name, category_id, is_active)
       select $1, 'secreto del vecino', 'Secreto del vecino', category_id, true
       from public.ingredients where canonical_name = 'pechuga de pollo sin piel'
       returning id`,
      [hogarB.householdId],
    ))!.id;
  });

  await h.como(USER_A, async () => {
    proveedorA = (await h.fila<{ id: string }>(
      `insert into public.suppliers (household_id, name, contact) values ($1, 'Avícola Sur', '+56 9 1234')
       returning id`,
      [hogarA.householdId],
    ))!.id;
    presentacionA = (await h.fila<{ id: string }>(
      `insert into public.supplier_products
         (supplier_id, ingredient_id, presentation, package_quantity, unit,
          minimum_order_quantity, lead_time_days, delivery_days)
       values ($1, $2, 'caja 1 kg', 1000, 'G', 5000, 2, array[5])
       returning id`,
      [proveedorA, polloId],
    ))!.id;
  });
});

afterAll(async () => {
  await h.cerrar();
});

function itemsPollo(qty = 5000) {
  return JSON.stringify([
    {
      ingredient_id: polloId,
      supplier_product_id: presentacionA,
      label: "Pechuga de pollo",
      required_quantity: 4000,
      suggested_quantity: qty,
      unit: "G",
      package_count: Math.ceil(qty / 1000),
      provenance: [{ step: "necesidad", detail: "test" }],
    },
  ]);
}

describe("ámbito por hogar (lentes F y §25 hogar A vs B)", () => {
  it("el hogar B no ve proveedores ni presentaciones del hogar A", async () => {
    const proveedores = await h.como(USER_B, () =>
      h.filas("select id from public.suppliers where household_id = $1", [hogarA.householdId]),
    );
    expect(proveedores).toHaveLength(0);
    const presentaciones = await h.como(USER_B, () =>
      h.filas("select id from public.supplier_products where id = $1", [presentacionA]),
    );
    expect(presentaciones).toHaveLength(0);
  });

  it("una presentación no puede apuntar a un alimento privado de OTRO hogar", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query(
          `insert into public.supplier_products (supplier_id, ingredient_id, presentation, package_quantity, unit)
           values ($1, $2, 'contrabando', 100, 'G')`,
          [proveedorA, privadoB],
        ),
      ),
    ).rejects.toThrow(/no pertenece/);
  });

  it("la política no acepta un proveedor de OTRO hogar", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query(
          `insert into public.purchase_policies (household_id, ingredient_id, preferred_supplier_id)
           values ($1, $2, $3)`,
          [hogarB.householdId, polloId, proveedorA],
        ),
      ),
    ).rejects.toThrow(/no pertenece/);
  });

  it("inyección de UUID: el hogar B no crea órdenes A NOMBRE del hogar A", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query("select public.create_procurement_order($1, null, null, null, null, 'v', $2::jsonb)", [
          hogarA.householdId,
          itemsPollo(),
        ]),
      ),
    ).rejects.toThrow(/no autorizado/);
  });
});

describe("aceptación idempotente (§22) y máquina de estados (§13)", () => {
  let orden: string;

  it("crear con dedupe_key dos veces = UNA orden (el doble clic no duplica)", async () => {
    const args = [
      hogarA.householdId,
      proveedorA,
      "2026-08-26",
      "2026-08-28",
      "PO:test:pollo:2026-08-26",
      "purchase-schedule/1.0.0",
      itemsPollo(),
    ];
    const primera = await h.como(USER_A, async () =>
      (await h.fila<{ create_procurement_order: string }>(
        "select public.create_procurement_order($1, $2, $3::date, $4::date, $5, $6, $7::jsonb)",
        args,
      ))!.create_procurement_order,
    );
    const segunda = await h.como(USER_A, async () =>
      (await h.fila<{ create_procurement_order: string }>(
        "select public.create_procurement_order($1, $2, $3::date, $4::date, $5, $6, $7::jsonb)",
        args,
      ))!.create_procurement_order,
    );
    expect(segunda).toBe(primera);
    orden = primera;

    const filas = await h.como(USER_A, () =>
      h.filas("select id, status from public.procurement_orders where household_id = $1", [hogarA.householdId]),
    );
    expect(filas).toHaveLength(1);
    expect((filas[0] as { status: string }).status).toBe("PLANNED");
  });

  it("una orden no acepta alimentos privados de otro hogar", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.create_procurement_order($1, null, null, null, null, 'v', $2::jsonb)", [
          hogarA.householdId,
          JSON.stringify([
            { ingredient_id: privadoB, label: "Contrabando", required_quantity: 1, suggested_quantity: 1, unit: "G" },
          ]),
        ]),
      ),
    ).rejects.toThrow(/no pertenece/);
  });

  it("PLANNED no salta a RECEIVED por advance; recibir exige orden pedida", async () => {
    await expect(
      h.como(USER_A, () => h.db.query("select public.advance_procurement_order($1, 'RECEIVED')", [orden])),
    ).rejects.toThrow(/no puede pasar/);
    await expect(
      h.como(USER_A, () => h.db.query("select public.receive_procurement_order($1)", [orden])),
    ).rejects.toThrow(/solo se recibe/);
  });

  it("el hogar B no avanza órdenes ajenas (ni sabe que existen)", async () => {
    await expect(
      h.como(USER_B, () => h.db.query("select public.advance_procurement_order($1, 'ORDERED')", [orden])),
    ).rejects.toThrow(/no autorizado/);
  });

  it("PLANNED→ORDERED avanza; repetir el mismo estado es un no-op (reintento §25)", async () => {
    await h.como(USER_A, () => h.db.query("select public.advance_procurement_order($1, 'ORDERED')", [orden]));
    await h.como(USER_A, () => h.db.query("select public.advance_procurement_order($1, 'ORDERED')", [orden]));
    const fila = await h.como(USER_A, () =>
      h.fila<{ status: string }>("select status from public.procurement_orders where id = $1", [orden]),
    );
    expect(fila!.status).toBe("ORDERED");
  });

  it("recibir crea lotes por el MISMO ledger (K-22); recibir dos veces NO duplica", async () => {
    const creados = await h.como(USER_A, async () =>
      (await h.fila<{ receive_procurement_order: number }>(
        "select public.receive_procurement_order($1)",
        [orden],
      ))!.receive_procurement_order,
    );
    expect(creados).toBe(1);

    const lotes = await h.como(USER_A, () =>
      h.filas<{ quantity: string; unit: string; weight_basis: string }>(
        `select l.quantity::text, l.unit, l.weight_basis::text
         from public.inventory_lots l
         where l.household_id = $1 and l.ingredient_id = $2 and l.status = 'AVAILABLE'`,
        [hogarA.householdId, polloId],
      ),
    );
    expect(lotes).toHaveLength(1);
    expect(Number(lotes[0]!.quantity)).toBe(5000);
    expect(lotes[0]!.weight_basis).toBe("RAW");

    // El movimiento existe con la clave de idempotencia del item.
    const movimientos = await h.como(USER_A, () =>
      h.filas(
        `select m.id from public.inventory_movements m
         join public.procurement_order_items i on m.idempotency_key = 'RECEIVE-PO:' || i.id::text
         where i.order_id = $1 and m.reason = 'PURCHASE'`,
        [orden],
      ),
    );
    expect(movimientos).toHaveLength(1);

    // La orden quedó RECEIVED... y el segundo intento de recepción no pasa
    // (ya no está en estado recibible) — jamás un segundo lote.
    const estado = await h.como(USER_A, () =>
      h.fila<{ status: string }>("select status from public.procurement_orders where id = $1", [orden]),
    );
    expect(estado!.status).toBe("RECEIVED");
    await expect(
      h.como(USER_A, () => h.db.query("select public.receive_procurement_order($1)", [orden])),
    ).rejects.toThrow(/solo se recibe/);

    const conteo = await h.como(USER_A, () =>
      h.filas("select id from public.inventory_lots where household_id = $1 and ingredient_id = $2", [
        hogarA.householdId,
        polloId,
      ]),
    );
    expect(conteo).toHaveLength(1);
  });

  it("RECEIVED→STORED cierra el ciclo; una cancelada no revive", async () => {
    await h.como(USER_A, () => h.db.query("select public.advance_procurement_order($1, 'STORED')", [orden]));

    const cancelable = await h.como(USER_A, async () =>
      (await h.fila<{ create_procurement_order: string }>(
        "select public.create_procurement_order($1, $2, null, null, 'PO:test:cancelar', 'v', $3::jsonb)",
        [hogarA.householdId, proveedorA, itemsPollo(1000)],
      ))!.create_procurement_order,
    );
    await h.como(USER_A, () =>
      h.db.query("select public.advance_procurement_order($1, 'CANCELLED')", [cancelable]),
    );
    await expect(
      h.como(USER_A, () => h.db.query("select public.advance_procurement_order($1, 'ORDERED')", [cancelable])),
    ).rejects.toThrow(/no puede pasar/);
  });

  it("las escrituras directas a órdenes están cerradas (solo RPC)", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query("insert into public.procurement_orders (household_id) values ($1)", [hogarA.householdId]),
      ),
    ).rejects.toThrow();
    // Sin policy de UPDATE, RLS deja el update en 0 filas: nada cambia.
    const resultado = await h.como(USER_A, () =>
      h.db.query("update public.procurement_orders set status = 'CANCELLED' where household_id = $1", [
        hogarA.householdId,
      ]),
    );
    expect((resultado as { affectedRows?: number }).affectedRows ?? 0).toBe(0);
    const estados = await h.como(USER_A, () =>
      h.filas<{ status: string }>(
        "select status from public.procurement_orders where household_id = $1 order by created_at",
        [hogarA.householdId],
      ),
    );
    expect(estados.map((e) => e.status)).toEqual(["STORED", "CANCELLED"]);
  });
});
