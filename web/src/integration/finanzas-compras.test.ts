import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 14 — compras, reparto de costo y el primer peso que entra a un lote.
 *
 * Prueba las 0043 y 0044 contra un PostgreSQL de verdad. No prueba "que las
 * tablas existan": cada test está escrito para ponerse rojo si el arreglo se
 * revierte.
 *
 *   - `inventory_lots.acquisition_value` llevaba siete sprints en NULL porque
 *     ningún camino de recepción la escribía. Ahora hay un receptor único.
 *   - Recibir el sábado y subir la boleta el domingo NO puede duplicar el stock.
 *   - Un valor DESCONOCIDO no puede absorberse como "redondeo": bloquea el cuadre.
 *   - Repartir un despacho entre N líneas conserva el total al peso, siempre.
 *   - Cocinar, partir o mover un lote NO es consumo económico.
 *
 * POR QUÉ APLICA LAS MIGRACIONES A MANO: `harness.ts` lo comparten varios
 * agentes del mismo sprint y su lista `MIGRACIONES` todavía llega a la 0038.
 * Mismo patrón que sprint13-eventos.test.ts.
 *
 * Y POR QUÉ EXISTE EL ANDAMIO: los permisos financieros (`app.finance_access`,
 * `public.finance_permission`) son la Etapa 2 y los escribe otro frente; todavía
 * no están en el árbol. `andamio-finanzas.sql` levanta EXACTO ese contrato —y
 * solo si el helper de verdad no existe— para poder correr estas pruebas hoy.
 * El cimiento del dinero sí es el de verdad: la 0042 ya está en el disco.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const ANDAMIO = path.join(__dirname, "andamio-finanzas.sql");
const USER_ANA = "00000000-0000-0000-0000-0000000014a1";
const USER_BETO = "00000000-0000-0000-0000-0000000014a2";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let betoMemberId: string;
let pollo: string;
let arroz: string;
let atun: string;
let congelador: string;

interface Intento {
  rechazado: boolean;
  mensaje: string | null;
}

async function intentar(sql: string, params: unknown[] = []): Promise<Intento> {
  try {
    await h.db.query(sql, params);
    return { rechazado: false, mensaje: null };
  } catch (e) {
    return { rechazado: true, mensaje: (e as Error).message };
  }
}

/** Compra manual completa por el RPC, como la haría la aplicación. */
async function comprar(opciones: {
  lineas: unknown[];
  cargos?: unknown[];
  totalMinor: number | null;
  totalSource?: "PRINTED" | "SUMMED" | "UNKNOWN";
  idempotency?: string | null;
  comercio?: string;
}): Promise<string> {
  const r = await h.como(USER_ANA, () =>
    h.fila<{ record_purchase: string }>(
      `select public.record_purchase($1, 'SUPERMARKET', $2, null, '2026-08-20',
              $3::bigint, $4::public.receipt_total_source, $5::jsonb, $6::jsonb, null, $7)`,
      [
        hogar.householdId,
        opciones.comercio ?? "Supermercado del barrio",
        opciones.totalMinor === null ? null : String(opciones.totalMinor),
        opciones.totalSource ?? "PRINTED",
        JSON.stringify(opciones.lineas),
        JSON.stringify(opciones.cargos ?? []),
        opciones.idempotency ?? null,
      ],
    ),
  );
  return r!.record_purchase;
}

/** Una línea de boleta con precio conocido. */
function linea(label: string, ingredientId: string, gramos: number, subtotal: number) {
  return {
    raw_label: label,
    ingredient_id: ingredientId,
    quantity: gramos,
    unit: "G",
    weight_basis: "RAW",
    line_subtotal_minor: subtotal,
  };
}

/**
 * Saca stock de un lote por el ledger y lo costea, respetando el contrato del
 * lock (cantidad previa tomada ANTES de insertar el movimiento).
 *
 * Usa `USED_IN_RECIPE` y no `CONSUMED` porque la 0036 exige que todo descuento
 * por comer cuelgue de un renglón de servido; acá lo que se prueba es el costeo,
 * no el registro de la comida. Las dos razones caen en la misma categoría.
 */
async function consumir(
  lotId: string,
  cantidad: number,
  razon = "USED_IN_RECIPE",
): Promise<{ movementId: string; allocationId: string }> {
  return h.comoAdmin(async () => {
    const antes = await h.fila<{ quantity: string; household_id: string }>(
      "select quantity, household_id from public.inventory_lots where id = $1 for update",
      [lotId],
    );
    const mov = await h.fila<{ id: string }>(
      `insert into public.inventory_movements (household_id, lot_id, reason, delta)
       values ($1, $2, $3::public.movement_reason, $4) returning id`,
      [antes!.household_id, lotId, razon, -cantidad],
    );
    const asignacion = await h.fila<{ allocate_movement_cost: string }>(
      "select app.allocate_movement_cost($1, $2, null, '2026-08-21')",
      [mov!.id, antes!.quantity],
    );
    return { movementId: mov!.id, allocationId: asignacion!.allocate_movement_cost };
  });
}

beforeAll(async () => {
  h = await levantarBase();

  await h.comoAdmin(async () => {
    // El arnés podría adelantarse: cada migración se aplica solo si su testigo
    // dice que todavía no está. ERROR != VACÍO también acá — si falta el
    // archivo, revienta con nombre y apellido en vez de saltárselo.
    const testigos: Array<[string, string]> = [
      ["supabase/migrations/0042_finance_foundations.sql", "to_regclass('public.currency_units')"],
      ["supabase/migrations/0043_purchases_core.sql", "to_regclass('public.purchase_item_lots')"],
      ["supabase/migrations/0044_cost_allocations.sql", "to_regclass('public.cost_allocations')"],
    ];
    for (const [archivo, testigo] of testigos) {
      const ya = await h.fila<{ t: string | null }>(`select ${testigo} as t`);
      if (ya!.t !== null) continue;
      if (archivo.includes("0043")) {
        // Los permisos financieros son la Etapa 2 y todavía no existen: sin el
        // helper, la RLS de la 0043 no se puede ni declarar.
        const helper = await h.fila<{ t: boolean }>(
          `select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'app' and p.proname = 'finance_access') as t`,
        );
        if (!helper!.t) await h.db.exec(readFileSync(ANDAMIO, "utf8"));
      }
      await h.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8"));
    }
  });

  hogar = await crearHogar(h, USER_ANA, "Hogar Finanzas", "Ana");

  await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      USER_BETO,
      "beto14@test.dev",
    ]);
    const m = await h.fila<{ id: string }>(
      `insert into public.household_members (household_id, user_id, display_name, birth_date)
       values ($1, $2, 'Beto', '1990-01-01') returning id`,
      [hogar.householdId, USER_BETO],
    );
    betoMemberId = m!.id;

    const ingredientes = await h.filas<{ id: string }>(
      "select id from public.ingredients order by display_name limit 3",
    );
    pollo = ingredientes[0]!.id;
    arroz = ingredientes[1]!.id;
    atun = ingredientes[2]!.id;
  });

  await h.como(USER_ANA, async () => {
    await h.db.query("select public.ensure_storage_locations($1)", [hogar.householdId]);
  });
  const loc = await h.comoAdmin(() =>
    h.fila<{ id: string }>(
      "select id from public.storage_locations where household_id = $1 and kind = 'FREEZER'",
      [hogar.householdId],
    ),
  );
  congelador = loc!.id;
});

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------

describe("el escritor legítimo de acquisition_value", () => {
  it("una compra de 5 kg de pollo a $25.000 deja el valor EN el lote", async () => {
    const compra = await comprar({
      lineas: [linea("POLLO ENTERO", pollo, 5000, 25000)],
      totalMinor: 25000,
      idempotency: "compra-pollo-1",
    });

    const lote = await h.comoAdmin(() =>
      h.fila<{ value_minor: string; value_status: string; acquisition_value: string; quantity: string; id: string }>(
        `select l.id, l.value_minor, l.value_status, l.acquisition_value, l.quantity
         from public.inventory_lots l
         join public.purchase_item_lots pil on pil.lot_id = l.id
         join public.purchase_items i on i.id = pil.purchase_item_id
         where i.purchase_id = $1`,
        [compra],
      ),
    );

    // Antes de este sprint esta columna era NULL para todo lote de producción:
    // ningún camino de recepción la escribía.
    expect(lote).not.toBeNull();
    expect(lote!.value_status).toBe("KNOWN");
    expect(Number(lote!.value_minor)).toBe(25000);
    // Y su espejo en numeric, que es lo que mira la maquinaria K-19 de split/merge.
    expect(Number(lote!.acquisition_value)).toBe(25000);
    expect(Number(lote!.quantity)).toBe(5000);

    const movs = await h.comoAdmin(() =>
      h.filas<{ reason: string }>("select reason from public.inventory_movements where lot_id = $1", [
        lote!.id,
      ]),
    );
    expect(movs).toHaveLength(1);
    expect(movs[0]!.reason).toBe("PURCHASE");
  });

  it("registrar la misma compra dos veces devuelve la misma compra y no duplica lotes", async () => {
    const a = await comprar({
      lineas: [linea("ARROZ 1 KG", arroz, 1000, 1490)],
      totalMinor: 1490,
      idempotency: "compra-arroz-idem",
    });
    const b = await comprar({
      lineas: [linea("ARROZ 1 KG", arroz, 1000, 1490)],
      totalMinor: 1490,
      idempotency: "compra-arroz-idem",
    });
    expect(b).toBe(a);

    const lotes = await h.comoAdmin(() =>
      h.filas("select 1 from public.purchase_item_lots pil join public.purchase_items i on i.id = pil.purchase_item_id where i.purchase_id = $1", [a]),
    );
    expect(lotes).toHaveLength(1);
  });

  it("el pedido a proveedor recibido en el congelador nace FROZEN y deja rastro del pedido", async () => {
    const { orderId, itemId } = await h.comoAdmin(async () => {
      const prov = await h.fila<{ id: string }>(
        "insert into public.suppliers (household_id, name) values ($1, 'Distribuidora Sur') returning id",
        [hogar.householdId],
      );
      const orden = await h.fila<{ id: string }>(
        `insert into public.procurement_orders (household_id, supplier_id, status, order_date)
         values ($1, $2, 'ORDERED', '2026-08-20') returning id`,
        [hogar.householdId, prov!.id],
      );
      const item = await h.fila<{ id: string }>(
        `insert into public.procurement_order_items
           (order_id, ingredient_id, label, required_quantity, suggested_quantity, unit, weight_basis)
         values ($1, $2, 'Pollo mayorista', 10000, 10000, 'G', 'RAW') returning id`,
        [orden!.id, pollo],
      );
      return { orderId: orden!.id, itemId: item!.id };
    });

    const recibidos = await h.como(USER_ANA, () =>
      h.fila<{ receive_procurement_order: number }>(
        "select public.receive_procurement_order($1, $2)",
        [orderId, congelador],
      ),
    );
    expect(recibidos!.receive_procurement_order).toBe(1);

    const lote = await h.comoAdmin(() =>
      h.fila<{
        temperature_state: string;
        frozen_at: string | null;
        procurement_item_id: string | null;
        value_minor: string | null;
        value_status: string;
      }>(
        `select temperature_state, frozen_at, procurement_item_id, value_minor, value_status
         from public.inventory_lots where procurement_item_id = $1`,
        [itemId],
      ),
    );
    // [C-3] cerrado para el camino B: hasta hoy este receptor metía lotes
    // AMBIENT al congelador y no dejaba ninguna huella del pedido.
    expect(lote!.temperature_state).toBe("FROZEN");
    expect(lote!.frozen_at).not.toBeNull();
    expect(lote!.procurement_item_id).toBe(itemId);
    // Un pedido sin boleta NO inventa un precio: el valor queda DESCONOCIDO.
    expect(lote!.value_minor).toBeNull();
    expect(lote!.value_status).toBe("UNKNOWN");

    // Reintento: no duplica.
    const otra = await h.como(USER_ANA, () =>
      h.fila<{ receive_procurement_order: number }>(
        "select public.receive_procurement_order($1, $2)",
        [orderId, congelador],
      ),
    );
    expect(otra!.receive_procurement_order).toBe(0);
    const cuantos = await h.comoAdmin(() =>
      h.filas("select 1 from public.inventory_lots where procurement_item_id = $1", [itemId]),
    );
    expect(cuantos).toHaveLength(1);
  });

  it("add_manual_lot con la misma clave dos veces crea UN lote, no dos", async () => {
    const uno = await h.como(USER_ANA, () =>
      h.fila<{ add_manual_lot: string }>(
        `select public.add_manual_lot($1, 'Sobras de cazuela', 800, 'G', null, null, null, null, 'COOKED', 'form-42')`,
        [hogar.householdId],
      ),
    );
    const dos = await h.como(USER_ANA, () =>
      h.fila<{ add_manual_lot: string }>(
        `select public.add_manual_lot($1, 'Sobras de cazuela', 800, 'G', null, null, null, null, 'COOKED', 'form-42')`,
        [hogar.householdId],
      ),
    );
    expect(dos!.add_manual_lot).toBe(uno!.add_manual_lot);

    const movs = await h.comoAdmin(() =>
      h.filas("select 1 from public.inventory_movements where lot_id = $1", [uno!.add_manual_lot]),
    );
    expect(movs).toHaveLength(1);
  });

  it("agregar el parámetro de idempotencia no dejó dos sobrecargas ambiguas", async () => {
    // Agregar un argumento con default NO reemplaza una función: crea una
    // SEGUNDA, y toda llamada con menos argumentos —la de pantry/actions.ts, la
    // de despensa.test.ts— se vuelve ambigua y revienta en runtime. La 0019 ya
    // había tropezado con esto; por eso la 0043 hace el `drop` antes.
    const cuantas = await h.comoAdmin(() =>
      h.filas(
        `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'add_manual_lot'`,
      ),
    );
    expect(cuantas).toHaveLength(1);

    const corta = await h.como(USER_ANA, () =>
      intentar("select public.add_manual_lot($1, 'Sin clave', 100, 'G', null, null, null, null)", [
        hogar.householdId,
      ]),
    );
    expect(corta.rechazado).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("la boleta que llega DESPUÉS de recibir la mercadería", () => {
  it("deposita el valor sin crear ni un movimiento nuevo", async () => {
    const lote = await h.como(USER_ANA, () =>
      h.fila<{ add_manual_lot: string }>(
        `select public.add_manual_lot($1, 'Pollo del sábado', 5000, 'G', $2, null, null, null, 'RAW', 'sabado-1')`,
        [hogar.householdId, pollo],
      ),
    );
    const lotId = lote!.add_manual_lot;

    const compra = await h.comoAdmin(async () => {
      const p = await h.fila<{ id: string }>(
        `insert into public.purchases (household_id, channel, source, merchant_name, merchant_key,
            purchased_on, currency, declared_total_minor, total_status, total_unknown_reason,
            total_source, allocation_policy_version, allocation_policy_snapshot)
         values ($1, 'SUPERMARKET', 'RECEIPT_IMPORT', 'Súper', 'super', '2026-08-20', 'CLP',
                 25000, 'KNOWN', null, 'PRINTED', app.cost_allocation_engine_version(),
                 app.allocation_policy_snapshot('CLP')) returning id`,
        [hogar.householdId],
      );
      const i = await h.fila<{ id: string }>(
        `insert into public.purchase_items (purchase_id, household_id, line_ordinal, raw_label,
            ingredient_id, quantity_canonical, unit, line_subtotal_minor, line_discount_minor,
            line_discount_status, line_discount_unknown_reason,
            allocated_charges_minor, allocated_charges_status, allocated_charges_unknown_reason,
            final_value_minor, value_status, unknown_reason)
         values ($1, $2, 1, 'POLLO ENTERO', $3, 5000, 'G', 25000, 0, 'KNOWN', null,
                 0, 'KNOWN', null, 25000, 'KNOWN', null) returning id`,
        [p!.id, hogar.householdId, pollo],
      );
      return { purchaseId: p!.id, itemId: i!.id };
    });

    const movsAntes = await h.comoAdmin(() =>
      h.filas("select 1 from public.inventory_movements where lot_id = $1", [lotId]),
    );

    await h.comoAdmin(() =>
      h.db.query("select app.value_lot_from_purchase_item($1, $2, 5000, 25000)", [
        compra.itemId,
        lotId,
      ]),
    );

    const despues = await h.comoAdmin(() =>
      h.fila<{ value_minor: string; quantity: string }>(
        "select value_minor, quantity from public.inventory_lots where id = $1",
        [lotId],
      ),
    );
    const movsDespues = await h.comoAdmin(() =>
      h.filas("select 1 from public.inventory_movements where lot_id = $1", [lotId]),
    );

    expect(Number(despues!.value_minor)).toBe(25000);
    // Este es EL caso que duplica stock si se hace mal: la mercadería ya estaba
    // en la despensa, así que adjuntar la boleta no puede mover ni un gramo.
    expect(Number(despues!.quantity)).toBe(5000);
    expect(movsDespues).toHaveLength(movsAntes.length);

    // Y no se revaloriza: un segundo intento sobre un lote que ya vale se niega.
    const otra = await intentar("select app.value_lot_from_purchase_item($1, $2, 5000, 30000)", [
      compra.itemId,
      lotId,
    ]);
    expect(otra.rechazado).toBe(true);
    expect(otra.mensaje).toMatch(/no se revaloriza/i);
  });

  it("se niega a valorizar un lote que ya se partió, en vez de contar la plata dos veces", async () => {
    const lote = await h.como(USER_ANA, () =>
      h.fila<{ add_manual_lot: string }>(
        `select public.add_manual_lot($1, 'Carne a repartir', 3000, 'G', $2, null, null, null, 'RAW', 'partir-1')`,
        [hogar.householdId, pollo],
      ),
    );
    await h.como(USER_ANA, () =>
      h.db.query("select public.split_lot($1, array[1000, 2000]::numeric[])", [
        lote!.add_manual_lot,
      ]),
    );

    const item = await h.comoAdmin(async () => {
      const p = await h.fila<{ id: string }>(
        `insert into public.purchases (household_id, channel, source, merchant_name, merchant_key,
            purchased_on, currency, total_status, total_unknown_reason, total_source,
            allocation_policy_version, allocation_policy_snapshot)
         values ($1, 'MARKET', 'MANUAL', 'Feria', 'feria', '2026-08-20', 'CLP',
                 'UNKNOWN', 'NO_PRICE_RECORDED', 'UNKNOWN', app.cost_allocation_engine_version(),
                 app.allocation_policy_snapshot('CLP')) returning id`,
        [hogar.householdId],
      );
      const i = await h.fila<{ id: string }>(
        `insert into public.purchase_items (purchase_id, household_id, line_ordinal, raw_label,
            ingredient_id, quantity_canonical, unit, line_subtotal_minor, line_discount_minor,
            line_discount_status, line_discount_unknown_reason,
            final_value_minor, value_status, unknown_reason)
         values ($1, $2, 1, 'CARNE', $3, 3000, 'G', 12000, 0, 'KNOWN', null,
                 12000, 'KNOWN', null) returning id`,
        [p!.id, hogar.householdId, pollo],
      );
      return i!.id;
    });

    const r = await intentar("select app.value_lot_from_purchase_item($1, $2, 3000, 12000)", [
      item,
      lote!.add_manual_lot,
    ]);
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toMatch(/ya se partió|dos veces/i);
  });
});

// ---------------------------------------------------------------------------

describe("el reparto de cargos conserva el total, o bloquea", () => {
  it("$3.499 de despacho entre 7 líneas suman exactamente $3.499", async () => {
    const compra = await comprar({
      lineas: Array.from({ length: 7 }, (_, i) => linea(`ITEM ${i + 1}`, arroz, 1000, 1000)),
      cargos: [
        { kind: "DELIVERY", label: "Despacho", amount_minor: 3499, policy: "PRO_RATA_VALUE" },
      ],
      totalMinor: 7000 + 3499,
      idempotency: "compra-despacho",
    });

    const filas = await h.comoAdmin(() =>
      h.filas<{ line_ordinal: number; allocated_charges_minor: string; final_value_minor: string }>(
        `select line_ordinal, allocated_charges_minor, final_value_minor
         from public.purchase_items where purchase_id = $1 order by line_ordinal`,
        [compra],
      ),
    );
    const suma = filas.reduce((acc, f) => acc + Number(f.allocated_charges_minor), 0);
    expect(suma).toBe(3499);
    // Residuo determinista: los seis primeros ordinales se llevan el peso extra.
    expect(filas.map((f) => Number(f.allocated_charges_minor))).toEqual([
      500, 500, 500, 500, 500, 500, 499,
    ]);
    expect(Number(filas[0]!.final_value_minor)).toBe(1500);
  });

  it("con una línea de valor DESCONOCIDO no reparte nada y dice por qué", async () => {
    const { purchaseId } = await h.comoAdmin(async () => {
      const p = await h.fila<{ id: string }>(
        `insert into public.purchases (household_id, channel, source, merchant_name, merchant_key,
            purchased_on, currency, total_status, total_unknown_reason, total_source,
            allocation_policy_version, allocation_policy_snapshot)
         values ($1, 'SUPERMARKET', 'RECEIPT_IMPORT', 'Súper', 'super', '2026-08-20', 'CLP',
                 'UNKNOWN', 'NO_PRICE_RECORDED', 'UNKNOWN', app.cost_allocation_engine_version(),
                 app.allocation_policy_snapshot('CLP')) returning id`,
        [hogar.householdId],
      );
      for (const [ordinal, subtotal] of [
        [1, 1000],
        [2, null],
      ] as Array<[number, number | null]>) {
        await h.db.query(
          `insert into public.purchase_items (purchase_id, household_id, line_ordinal, raw_label,
              ingredient_id, quantity_canonical, unit, line_subtotal_minor,
              line_discount_minor, line_discount_status, line_discount_unknown_reason)
           values ($1, $2, $3, 'LINEA', $4, 1000, 'G', $5, 0, 'KNOWN', null)`,
          [p!.id, hogar.householdId, ordinal, arroz, subtotal],
        );
      }
      await h.db.query(
        `insert into public.purchase_charges (purchase_id, household_id, kind, label,
            amount_minor, policy, applied_policy_version)
         values ($1, $2, 'DELIVERY', 'Despacho', 2000, 'PRO_RATA_VALUE',
                 app.cost_allocation_engine_version())`,
        [p!.id, hogar.householdId],
      );
      return { purchaseId: p!.id };
    });

    const r = await h.comoAdmin(() =>
      h.fila<{ allocate_purchase_charges: { ok: boolean; code: string; itemIds: string[] } }>(
        "select app.allocate_purchase_charges($1)",
        [purchaseId],
      ),
    );
    expect(r!.allocate_purchase_charges.ok).toBe(false);
    expect(r!.allocate_purchase_charges.code).toBe("UNKNOWN_LINE_VALUE");
    expect(r!.allocate_purchase_charges.itemIds).toHaveLength(1);

    // Y no tocó una sola línea: repartir "entre las conocidas" le regalaría el
    // despacho de un producto sin precio a los demás.
    const sinTocar = await h.comoAdmin(() =>
      h.filas<{ allocated_charges_status: string }>(
        "select allocated_charges_status from public.purchase_items where purchase_id = $1",
        [purchaseId],
      ),
    );
    expect(sinTocar.every((f) => f.allocated_charges_status === "UNKNOWN")).toBe(true);
  });

  it("PRO_RATA_WEIGHT se niega si una línea no tiene masa comparable", async () => {
    const purchaseId = await h.comoAdmin(async () => {
      const p = await h.fila<{ id: string }>(
        `insert into public.purchases (household_id, channel, source, merchant_name, merchant_key,
            purchased_on, currency, total_status, total_unknown_reason, total_source,
            allocation_policy_version, allocation_policy_snapshot)
         values ($1, 'SUPERMARKET', 'MANUAL', 'Súper', 'super', '2026-08-20', 'CLP',
                 'UNKNOWN', 'NO_PRICE_RECORDED', 'UNKNOWN', app.cost_allocation_engine_version(),
                 app.allocation_policy_snapshot('CLP')) returning id`,
        [hogar.householdId],
      );
      await h.db.query(
        `insert into public.purchase_items (purchase_id, household_id, line_ordinal, raw_label,
            ingredient_id, quantity_canonical, unit, weight_basis, line_subtotal_minor,
            line_discount_minor, line_discount_status, line_discount_unknown_reason)
         values ($1, $2, 1, 'ARROZ', $3, 1000, 'G', 'RAW', 1000, 0, 'KNOWN', null)`,
        [p!.id, hogar.householdId, arroz],
      );
      await h.db.query(
        `insert into public.purchase_items (purchase_id, household_id, line_ordinal, raw_label,
            ingredient_id, quantity_canonical, unit, weight_basis, line_subtotal_minor,
            line_discount_minor, line_discount_status, line_discount_unknown_reason)
         values ($1, $2, 2, 'PAN AMASADO', $3, 4, 'UNIT', 'RAW', 2000, 0, 'KNOWN', null)`,
        [p!.id, hogar.householdId, pollo],
      );
      await h.db.query(
        `insert into public.purchase_charges (purchase_id, household_id, kind, label,
            amount_minor, policy, applied_policy_version)
         values ($1, $2, 'DELIVERY', 'Despacho', 2000, 'PRO_RATA_WEIGHT',
                 app.cost_allocation_engine_version())`,
        [p!.id, hogar.householdId],
      );
      return p!.id;
    });

    const r = await h.comoAdmin(() =>
      h.fila<{ allocate_purchase_charges: { ok: boolean; code: string } }>(
        "select app.allocate_purchase_charges($1)",
        [purchaseId],
      ),
    );
    expect(r!.allocate_purchase_charges.ok).toBe(false);
    expect(r!.allocate_purchase_charges.code).toBe("NO_COMPARABLE_MASS");
  });

  it("dos bases físicas distintas sin factor anotado bloquean con su propio código", async () => {
    const purchaseId = await h.comoAdmin(async () => {
      const p = await h.fila<{ id: string }>(
        `insert into public.purchases (household_id, channel, source, merchant_name, merchant_key,
            purchased_on, currency, total_status, total_unknown_reason, total_source,
            allocation_policy_version, allocation_policy_snapshot)
         values ($1, 'SUPERMARKET', 'MANUAL', 'Súper', 'super', '2026-08-20', 'CLP',
                 'UNKNOWN', 'NO_PRICE_RECORDED', 'UNKNOWN', app.cost_allocation_engine_version(),
                 app.allocation_policy_snapshot('CLP')) returning id`,
        [hogar.householdId],
      );
      await h.db.query(
        `insert into public.purchase_items (purchase_id, household_id, line_ordinal, raw_label,
            ingredient_id, quantity_canonical, unit, weight_basis, line_subtotal_minor,
            line_discount_minor, line_discount_status, line_discount_unknown_reason)
         values ($1, $2, 1, 'ARROZ', $3, 1000, 'G', 'RAW', 1000, 0, 'KNOWN', null)`,
        [p!.id, hogar.householdId, arroz],
      );
      await h.db.query(
        `insert into public.purchase_items (purchase_id, household_id, line_ordinal, raw_label,
            ingredient_id, quantity_canonical, unit, weight_basis, line_subtotal_minor,
            line_discount_minor, line_discount_status, line_discount_unknown_reason)
         values ($1, $2, 2, 'ATUN LOMITOS', $3, 500, 'G', 'DRAINED', 3000, 0, 'KNOWN', null)`,
        [p!.id, hogar.householdId, atun],
      );
      await h.db.query(
        `insert into public.purchase_charges (purchase_id, household_id, kind, label,
            amount_minor, policy, applied_policy_version)
         values ($1, $2, 'DELIVERY', 'Despacho', 2000, 'PRO_RATA_WEIGHT',
                 app.cost_allocation_engine_version())`,
        [p!.id, hogar.householdId],
      );
      return p!.id;
    });

    const r = await h.comoAdmin(() =>
      h.fila<{ allocate_purchase_charges: { ok: boolean; code: string } }>(
        "select app.allocate_purchase_charges($1)",
        [purchaseId],
      ),
    );
    // Prohibido el 1:1 implícito entre RAW y DRAINED (gate 0-10 [B-1]).
    expect(r!.allocate_purchase_charges.ok).toBe(false);
    expect(r!.allocate_purchase_charges.code).toBe("BASIS_CONVERSION_MISSING");
  });

  it("un descuento mayor que todas las líneas bloquea en vez de dejar valores negativos", async () => {
    const r = await intentar(
      `select public.record_purchase($1, 'SUPERMARKET', 'Súper', null, '2026-08-20',
              null::bigint, 'UNKNOWN', $2::jsonb,
              '[{"kind":"ORDER_DISCOUNT","label":"Cupón gigante","amount_minor":-9000,"policy":"PRO_RATA_VALUE"}]'::jsonb,
              null, 'descuento-imposible')`,
      [hogar.householdId, JSON.stringify([linea("ARROZ", arroz, 1000, 1000)])],
    );
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toMatch(/DISCOUNT_EXCEEDS_LINES/);
  });

  it("la política se congela en la compra: cambiarla hoy no toca una compra vieja", async () => {
    const vieja = await comprar({
      lineas: [linea("ARROZ", arroz, 1000, 1000)],
      totalMinor: 1000,
      idempotency: "politica-vieja",
    });
    await h.comoAdmin(() =>
      h.db.query(
        "update public.currency_units set reconciliation_tolerance_minor = 999 where code = 'CLP'",
      ),
    );
    const nueva = await comprar({
      lineas: [linea("ARROZ", arroz, 1000, 1000)],
      totalMinor: 1000,
      idempotency: "politica-nueva",
    });

    const snaps = await h.comoAdmin(() =>
      h.filas<{ id: string; tol: string }>(
        `select id, allocation_policy_snapshot ->> 'toleranceMinor' as tol
         from public.purchases where id = any($1::uuid[])`,
        [[vieja, nueva]],
      ),
    );
    const porId = new Map(snaps.map((s) => [s.id, s.tol]));
    expect(porId.get(vieja)).toBe("5");
    expect(porId.get(nueva)).toBe("999");

    await h.comoAdmin(() =>
      h.db.query(
        "update public.currency_units set reconciliation_tolerance_minor = 5 where code = 'CLP'",
      ),
    );
  });
});

// ---------------------------------------------------------------------------

describe("la conciliación no inventa una línea para cuadrar", () => {
  it("$3 de descuadre en 20 líneas queda dentro de tolerancia y produce un cargo CON NOMBRE", async () => {
    const compra = await comprar({
      lineas: Array.from({ length: 20 }, (_, i) => linea(`ITEM ${i + 1}`, arroz, 500, 1000)),
      totalMinor: 20003,
      idempotency: "compra-redondeo",
    });

    const cargos = await h.comoAdmin(() =>
      h.filas<{ kind: string; label: string; amount_minor: string; policy: string }>(
        "select kind, label, amount_minor, policy from public.purchase_charges where purchase_id = $1",
        [compra],
      ),
    );
    expect(cargos).toHaveLength(1);
    expect(cargos[0]!.kind).toBe("ROUNDING");
    expect(cargos[0]!.label).toBe("Diferencia de redondeo de la boleta");
    expect(Number(cargos[0]!.amount_minor)).toBe(3);
    expect(cargos[0]!.policy).toBe("EXPENSE_ONLY");

    const p = await h.comoAdmin(() =>
      h.fila<{
        reconciliation: string;
        reconciliation_delta_before_adjustment_minor: string;
        reconciliation_delta_after_minor: string;
      }>(
        `select reconciliation, reconciliation_delta_before_adjustment_minor,
                reconciliation_delta_after_minor
         from public.purchases where id = $1`,
        [compra],
      ),
    );
    expect(p!.reconciliation).toBe("WITHIN_TOLERANCE");
    expect(Number(p!.reconciliation_delta_before_adjustment_minor)).toBe(3);
    expect(Number(p!.reconciliation_delta_after_minor)).toBe(0);

    // Recorrer la conciliación otra vez NO inventa un segundo ajuste ni cambia
    // el delta: sin excluir el ROUNDING del cálculo, esto acumulaba plata.
    await h.como(USER_ANA, () => h.db.query("select public.reconcile_purchase($1)", [compra]));
    const cargos2 = await h.comoAdmin(() =>
      h.filas<{ amount_minor: string }>(
        "select amount_minor from public.purchase_charges where purchase_id = $1",
        [compra],
      ),
    );
    expect(cargos2).toHaveLength(1);
    expect(Number(cargos2[0]!.amount_minor)).toBe(3);
  });

  it("$9.000 de descuadre bloquea la compra y no crea ninguna línea de ajuste", async () => {
    const r = await intentar(
      `select public.record_purchase($1, 'SUPERMARKET', 'Súper', null, '2026-08-20',
              29000::bigint, 'PRINTED', $2::jsonb, '[]'::jsonb, null, 'descuadre-grande')`,
      [hogar.householdId, JSON.stringify([linea("ARROZ", arroz, 1000, 20000)])],
    );
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toMatch(/no cuadra con el total impreso/i);

    const compras = await h.comoAdmin(() =>
      h.filas("select 1 from public.purchases where idempotency_key = 'descuadre-grande'"),
    );
    expect(compras).toHaveLength(0);
  });

  it("una línea de valor DESCONOCIDO bloquea el cuadre: nunca se absorbe como redondeo", async () => {
    // [H12] `sum()` de Postgres se salta los NULL. Sin la guarda, esta boleta
    // daba delta = 1.000 (dentro de tolerancia) y el desconocido terminaba
    // convertido en un cargo de redondeo con nombre falso.
    const compra = await comprar({
      lineas: [
        linea("ARROZ", arroz, 1000, 1000),
        {
          raw_label: "ILEGIBLE",
          ingredient_id: pollo,
          quantity: 1000,
          unit: "G",
          weight_basis: "RAW",
          line_subtotal_minor: null,
        },
      ],
      totalMinor: 2000,
      idempotency: "compra-linea-ilegible",
    });

    const p = await h.comoAdmin(() =>
      h.fila<{ reconciliation: string; reconciliation_delta_before_adjustment_minor: string | null }>(
        `select reconciliation, reconciliation_delta_before_adjustment_minor
         from public.purchases where id = $1`,
        [compra],
      ),
    );
    expect(p!.reconciliation).toBe("TOTAL_UNKNOWN");
    expect(p!.reconciliation_delta_before_adjustment_minor).toBeNull();

    const cargos = await h.comoAdmin(() =>
      h.filas("select 1 from public.purchase_charges where purchase_id = $1", [compra]),
    );
    expect(cargos).toHaveLength(0);

    // Y el lote de esa línea entra a la despensa con valor DESCONOCIDO, no en $0.
    const lote = await h.comoAdmin(() =>
      h.fila<{ value_minor: string | null }>(
        `select l.value_minor from public.inventory_lots l
         join public.purchase_item_lots pil on pil.lot_id = l.id
         join public.purchase_items i on i.id = pil.purchase_item_id
         where i.purchase_id = $1 and i.line_ordinal = 2`,
        [compra],
      ),
    );
    expect(lote!.value_minor).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("el consumo económico sale del mismo valor que entró", () => {
  it("de 5 kg a $25.000, comerse 2 kg cuesta $10.000 y quedan $15.000 guardados", async () => {
    const compra = await comprar({
      lineas: [linea("POLLO", pollo, 5000, 25000)],
      totalMinor: 25000,
      idempotency: "consumo-pollo",
    });
    const lote = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `select l.id from public.inventory_lots l
         join public.purchase_item_lots pil on pil.lot_id = l.id
         join public.purchase_items i on i.id = pil.purchase_item_id
         where i.purchase_id = $1`,
        [compra],
      ),
    );

    const { allocationId } = await consumir(lote!.id, 2000);
    const a = await h.comoAdmin(() =>
      h.fila<{ amount_minor: string; category: string; value_status: string; occurred_on: string }>(
        "select amount_minor, category, value_status, occurred_on from public.cost_allocations where id = $1",
        [allocationId],
      ),
    );
    expect(Number(a!.amount_minor)).toBe(10000);
    expect(a!.category).toBe("CONSUMED");
    expect(a!.value_status).toBe("KNOWN");

    const balance = await h.como(USER_ANA, () =>
      h.fila<{ remaining_minor: string; consumed_minor: string }>(
        "select remaining_minor, consumed_minor from public.lot_cost_balance where lot_id = $1",
        [lote!.id],
      ),
    );
    // La caja del día fueron $25.000; el consumo económico de la semana, $10.000.
    // Los otros $15.000 siguen siendo valor almacenado, no gasto.
    expect(Number(balance!.consumed_minor)).toBe(10000);
    expect(Number(balance!.remaining_minor)).toBe(15000);
  });

  it("tres tomas desiguales cierran el lote al peso, sin residuo colgando", async () => {
    const compra = await comprar({
      lineas: [linea("POLLO EN TROZOS", pollo, 3000, 17003)],
      totalMinor: 17003,
      idempotency: "consumo-desigual",
    });
    const lote = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `select l.id from public.inventory_lots l
         join public.purchase_item_lots pil on pil.lot_id = l.id
         join public.purchase_items i on i.id = pil.purchase_item_id
         where i.purchase_id = $1`,
        [compra],
      ),
    );

    await consumir(lote!.id, 700);
    await consumir(lote!.id, 1100);
    await consumir(lote!.id, 1200);

    const total = await h.comoAdmin(() =>
      h.fila<{ suma: string; cuantas: string }>(
        "select sum(amount_minor) as suma, count(*) as cuantas from public.cost_allocations where lot_id = $1",
        [lote!.id],
      ),
    );
    expect(Number(total!.cuantas)).toBe(3);
    expect(Number(total!.suma)).toBe(17003);

    const descuadres = await h.como(USER_ANA, () =>
      h.filas("select * from app.verify_lot_cost_invariant($1) where lot_id = $2", [
        hogar.householdId,
        lote!.id,
      ]),
    );
    expect(descuadres).toHaveLength(0);
  });

  it("un lote sin valor produce asignaciones DESCONOCIDAS con motivo, jamás $0", async () => {
    const lote = await h.como(USER_ANA, () =>
      h.fila<{ add_manual_lot: string }>(
        `select public.add_manual_lot($1, 'Regalo de la vecina', 1000, 'G', $2, null, null, null, 'RAW', 'regalo-1')`,
        [hogar.householdId, pollo],
      ),
    );
    const { allocationId } = await consumir(lote!.add_manual_lot, 400, "SPOILED");
    const a = await h.comoAdmin(() =>
      h.fila<{ amount_minor: string | null; value_status: string; unknown_reason: string; category: string }>(
        "select amount_minor, value_status, unknown_reason, category from public.cost_allocations where id = $1",
        [allocationId],
      ),
    );
    expect(a!.amount_minor).toBeNull();
    expect(a!.value_status).toBe("UNKNOWN");
    expect(a!.unknown_reason).toBe("LOT_VALUE_UNKNOWN");
    expect(a!.category).toBe("WASTED_AVOIDABLE");

    // Y el balance del lote NO devuelve un número: devuelve NULL, que es la verdad.
    const balance = await h.como(USER_ANA, () =>
      h.fila<{ remaining_minor: string | null; has_unknown_allocations: boolean }>(
        "select remaining_minor, has_unknown_allocations from public.lot_cost_balance where lot_id = $1",
        [lote!.add_manual_lot],
      ),
    );
    expect(balance!.remaining_minor).toBeNull();
    expect(balance!.has_unknown_allocations).toBe(true);
  });

  it("costear el mismo movimiento dos veces es un no-op, no un doble gasto", async () => {
    const compra = await comprar({
      lineas: [linea("ARROZ", arroz, 2000, 3000)],
      totalMinor: 3000,
      idempotency: "doble-costeo",
    });
    const lote = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `select l.id from public.inventory_lots l
         join public.purchase_item_lots pil on pil.lot_id = l.id
         join public.purchase_items i on i.id = pil.purchase_item_id
         where i.purchase_id = $1`,
        [compra],
      ),
    );
    const { movementId, allocationId } = await consumir(lote!.id, 500);
    const otra = await h.comoAdmin(() =>
      h.fila<{ allocate_movement_cost: string }>(
        "select app.allocate_movement_cost($1, 2000, null, '2026-08-21')",
        [movementId],
      ),
    );
    expect(otra!.allocate_movement_cost).toBe(allocationId);
    const cuantas = await h.comoAdmin(() =>
      h.filas("select 1 from public.cost_allocations where movement_id = $1", [movementId]),
    );
    expect(cuantas).toHaveLength(1);
  });

  it("cocinar o partir NO es consumo económico: costear una transferencia revienta", async () => {
    const lote = await h.como(USER_ANA, () =>
      h.fila<{ add_manual_lot: string }>(
        `select public.add_manual_lot($1, 'Pollo para el guiso', 2000, 'G', $2, null, null, null, 'RAW', 'guiso-1')`,
        [hogar.householdId, pollo],
      ),
    );
    const mov = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.inventory_movements (household_id, lot_id, reason, delta)
         values ($1, $2, 'TRANSFORM', -2000) returning id`,
        [hogar.householdId, lote!.add_manual_lot],
      ),
    );
    const r = await intentar("select app.allocate_movement_cost($1, 2000, null, '2026-08-21')", [
      mov!.id,
    ]);
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toMatch(/transferencia de valor/i);
  });

  it("una ENTRADA nunca se costea como salida", async () => {
    const lote = await h.como(USER_ANA, () =>
      h.fila<{ add_manual_lot: string }>(
        `select public.add_manual_lot($1, 'Ajuste hacia arriba', 500, 'G', $2, null, null, null, 'RAW', 'ajuste-1')`,
        [hogar.householdId, pollo],
      ),
    );
    const mov = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `insert into public.inventory_movements (household_id, lot_id, reason, delta)
         values ($1, $2, 'ADJUSTMENT', 300) returning id`,
        [hogar.householdId, lote!.add_manual_lot],
      ),
    );
    const r = await intentar("select app.allocate_movement_cost($1, 500, null, '2026-08-21')", [
      mov!.id,
    ]);
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toMatch(/solo se costea una SALIDA/i);
  });

  it("el despacho es gasto del período, no valor guardado en la despensa", async () => {
    const compra = await comprar({
      lineas: [linea("ARROZ", arroz, 1000, 1000)],
      cargos: [{ kind: "DELIVERY", label: "Despacho a domicilio", amount_minor: 2990, policy: "EXPENSE_ONLY" }],
      totalMinor: 3990,
      idempotency: "compra-despacho-gasto",
    });

    const cuantas = await h.comoAdmin(() =>
      h.fila<{ allocate_purchase_expense: number }>("select app.allocate_purchase_expense($1)", [
        compra,
      ]),
    );
    expect(cuantas!.allocate_purchase_expense).toBe(1);

    const a = await h.comoAdmin(() =>
      h.fila<{ category: string; amount_minor: string; occurred_on: string; lot_id: string | null }>(
        `select c.category, c.amount_minor, c.occurred_on::text as occurred_on, c.lot_id
         from public.cost_allocations c
         join public.purchase_charges g on g.id = c.purchase_charge_id
         where g.purchase_id = $1`,
        [compra],
      ),
    );
    expect(a!.category).toBe("NON_CAPITALIZED_EXPENSE");
    expect(Number(a!.amount_minor)).toBe(2990);
    expect(a!.occurred_on).toBe("2026-08-20");
    // No cuelga de ningún lote: capitalizar el despacho en el arroz dejaría el
    // kilo de arroz caro para siempre.
    expect(a!.lot_id).toBeNull();

    // Y el lote se quedó con el valor de su línea, sin el despacho encima.
    const lote = await h.comoAdmin(() =>
      h.fila<{ value_minor: string }>(
        `select l.value_minor from public.inventory_lots l
         join public.purchase_item_lots pil on pil.lot_id = l.id
         join public.purchase_items i on i.id = pil.purchase_item_id
         where i.purchase_id = $1`,
        [compra],
      ),
    );
    expect(Number(lote!.value_minor)).toBe(1000);

    // Correrlo de nuevo no duplica el gasto.
    const otra = await h.comoAdmin(() =>
      h.fila<{ allocate_purchase_expense: number }>("select app.allocate_purchase_expense($1)", [
        compra,
      ]),
    );
    expect(otra!.allocate_purchase_expense).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("historia y permisos", () => {
  it("el texto original de la boleta no se puede reescribir", async () => {
    const compra = await comprar({
      lineas: [linea("PLL ENT KG", pollo, 1000, 2500)],
      totalMinor: 2500,
      idempotency: "texto-original",
    });
    const r = await h.comoAdmin(() =>
      intentar(
        "update public.purchase_items set raw_label = 'Pollo entero' where purchase_id = $1",
        [compra],
      ),
    );
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toMatch(/no se reescribe/i);

    const sigue = await h.comoAdmin(() =>
      h.fila<{ raw_label: string }>(
        "select raw_label from public.purchase_items where purchase_id = $1",
        [compra],
      ),
    );
    expect(sigue!.raw_label).toBe("PLL ENT KG");
  });

  it("un integrante sin FINANCE_VIEW no ve ni un monto, aunque vea la despensa", async () => {
    await comprar({
      lineas: [linea("ARROZ", arroz, 1000, 1000)],
      totalMinor: 1000,
      idempotency: "rls-beto",
    });

    const vistas = await h.como(USER_BETO, async () => ({
      compras: await h.filas("select id from public.purchases"),
      lineas: await h.filas("select id from public.purchase_items"),
      costos: await h.filas("select id from public.cost_allocations"),
      despensa: await h.filas("select id from public.inventory_lots where household_id = $1", [
        hogar.householdId,
      ]),
    }));

    expect(vistas.compras).toHaveLength(0);
    expect(vistas.lineas).toHaveLength(0);
    expect(vistas.costos).toHaveLength(0);
    // La despensa sí: ver qué hay en la casa no es ver cuánto costó.
    expect(vistas.despensa.length).toBeGreaterThan(0);

    // Con el permiso otorgado, las compras aparecen.
    await h.comoAdmin(() =>
      h.db.query(
        `insert into public.household_finance_grants (household_id, member_id, permission, granted_by)
         values ($1, $2, 'FINANCE_VIEW', $3)`,
        [hogar.householdId, betoMemberId, hogar.memberId],
      ),
    );
    const conPermiso = await h.como(USER_BETO, () => h.filas("select id from public.purchases"));
    expect(conPermiso.length).toBeGreaterThan(0);
  });

  it("el cliente no puede escribir una compra por la puerta de atrás", async () => {
    const r = await h.como(USER_ANA, () =>
      intentar(
        `insert into public.purchases (household_id, channel, source, merchant_name, merchant_key,
            purchased_on, currency, total_status, total_unknown_reason, total_source,
            allocation_policy_version, allocation_policy_snapshot)
         values ($1, 'OTHER', 'MANUAL', 'Trampa', 'trampa', '2026-08-20', 'CLP',
                 'UNKNOWN', 'NO_PRICE_RECORDED', 'UNKNOWN', 'x', '{}'::jsonb)`,
        [hogar.householdId],
      ),
    );
    expect(r.rechazado).toBe(true);
  });
});
