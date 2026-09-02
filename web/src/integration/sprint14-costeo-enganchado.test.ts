import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 14 — EL COSTO QUE NUNCA SE ASIGNABA.
 *
 * Cuatro atacantes encontraron lo mismo por separado: `app.allocate_movement_cost`
 * no tenia NI UN llamador de produccion. Estaba escrita, no construida. Comer,
 * botar y ajustar no dejaban ni una fila de `cost_allocations`, y el panel
 * mostraba «Total consumido: $0» como un CERO CONOCIDO — la mentira exacta que
 * este sprint existe para impedir.
 *
 * Cada test de este archivo esta escrito contra LA MUTACION que lo revive:
 *
 *   1. Sacale el `perform app.allocate_movement_cost(...)` de
 *      `app.apply_movement_to_lot` (0044) y el descarte real deja de costear.
 *   2. Devolvele a `public.pantry_value` (0047) el `sum(l.value_minor)` y la
 *      despensa vuelve a no bajar cuando la casa come.
 *   3. Cambiale a `public.split_lot` (0044) el `v_restante` por
 *      `v_lot.value_minor` y el lote partido vuelve a inflar la despensa en
 *      exactamente lo ya consumido.
 *   4. Devolvele a `public.merge_lots` (0044) el `value_minor = 0` crudo y
 *      `app.assert_finance_integrity` revienta para ese hogar para siempre.
 *   5. Devolvele a `public.record_purchase` (0043) el `continue` mudo y la plata
 *      de una linea sin cantidad vuelve a contarse como «quedo en la despensa».
 *
 * POR QUE APLICA LAS MIGRACIONES A MANO: `harness.ts` lo comparten varios
 * agentes del mismo sprint y su lista `MIGRACIONES` llega a la 0038. Mismo
 * patron que finanzas-panel.test.ts y sprint13-eventos.test.ts.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const USER_ANA = "00000000-0000-0000-0000-0000000014c1";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let pollo: string;
let arroz: string;

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

/** Una linea de compra con precio conocido. */
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

/** Compra manual por el RPC de verdad, como la haria la aplicacion. */
async function comprar(lineas: unknown[], totalMinor: number, idem: string): Promise<string> {
  const r = await h.como(USER_ANA, () =>
    h.fila<{ record_purchase: string }>(
      `select public.record_purchase($1, 'SUPERMARKET', 'Supermercado del barrio', null,
              '2026-08-20', $2::bigint, 'PRINTED', $3::jsonb, '[]'::jsonb, null, $4)`,
      [hogar.householdId, String(totalMinor), JSON.stringify(lineas), idem],
    ),
  );
  return r!.record_purchase;
}

/** El lote que nacio de la unica linea de una compra. */
async function loteDe(compra: string): Promise<string> {
  const fila = await h.comoAdmin(() =>
    h.fila<{ lot_id: string }>(
      `select pil.lot_id from public.purchase_item_lots pil
        join public.purchase_items i on i.id = pil.purchase_item_id
       where i.purchase_id = $1 order by i.line_ordinal limit 1`,
      [compra],
    ),
  );
  return fila!.lot_id;
}

interface FilaLote {
  quantity: string;
  value_minor: string | null;
  value_status: string;
  value_unknown_reason: string | null;
}

async function lote(id: string): Promise<FilaLote> {
  const fila = await h.comoAdmin(() =>
    h.fila<FilaLote>(
      `select quantity::text as quantity, value_minor::text as value_minor,
              value_status, value_unknown_reason
         from public.inventory_lots where id = $1`,
      [id],
    ),
  );
  return fila!;
}

interface Asignacion {
  category: string;
  amount_minor: string | null;
  value_status: string;
  unknown_reason: string | null;
  quantity: string;
}

async function asignacionesDe(lotId: string): Promise<Asignacion[]> {
  return h.comoAdmin(() =>
    h.filas<Asignacion>(
      `select category::text as category, amount_minor::text as amount_minor,
              value_status::text as value_status, unknown_reason::text as unknown_reason,
              quantity::text as quantity
         from public.cost_allocations where lot_id = $1 order by created_at, id`,
      [lotId],
    ),
  );
}

interface SaldoDespensa {
  known_value_minor: string | null;
  unknown_lots: string;
  total_lots: string;
  value_status: string;
}

async function despensa(): Promise<SaldoDespensa | null> {
  return h.como(USER_ANA, () =>
    h.fila<SaldoDespensa>(
      `select known_value_minor::text as known_value_minor,
              unknown_lots::text as unknown_lots, total_lots::text as total_lots,
              value_status::text as value_status
         from public.pantry_value where household_id = $1`,
      [hogar.householdId],
    ),
  );
}

async function integridad(): Promise<Array<{ tipo: string; motivo: string; detalle: string }>> {
  return h.como(USER_ANA, () =>
    h.filas<{ tipo: string; motivo: string; detalle: string }>(
      `select tipo, motivo, detalle from public.finance_integrity_report
        where household_id = $1 order by tipo`,
      [hogar.householdId],
    ),
  );
}

beforeAll(async () => {
  h = await levantarBase();

  await h.comoAdmin(async () => {
    const testigos: Array<[string, string]> = [
      ["supabase/migrations/0042_finance_foundations.sql", "to_regclass('public.currency_units')"],
      ["supabase/migrations/0043_purchases_core.sql", "to_regclass('public.purchase_item_lots')"],
      ["supabase/migrations/0044_cost_allocations.sql", "to_regclass('public.cost_allocations')"],
      ["supabase/migrations/0046_price_observations.sql", "to_regclass('public.price_observations')"],
      ["supabase/migrations/0047_food_budgets.sql", "to_regclass('public.household_food_budgets')"],
      ["supabase/migrations/0048_finance_integrity.sql", "to_regclass('public.lot_valuations')"],
    ];
    for (const [archivo, testigo] of testigos) {
      const ya = await h.fila<{ t: string | null }>(`select ${testigo} as t`);
      if (ya!.t !== null) continue;
      await h.db.exec(readFileSync(path.join(RAIZ, archivo), "utf8"));
    }
  });

  hogar = await crearHogar(h, USER_ANA, "Hogar Costeo", "Ana");

  await h.comoAdmin(async () => {
    const ingredientes = await h.filas<{ id: string }>(
      "select id from public.ingredients order by display_name limit 2",
    );
    pollo = ingredientes[0]!.id;
    arroz = ingredientes[1]!.id;
  });

  await h.como(USER_ANA, async () => {
    await h.db.query("select public.ensure_storage_locations($1)", [hogar.householdId]);
  });
  // Seis migraciones grandes sobre PostgreSQL WASM: con la maquina cargada los
  // 10 s por omision de vitest se pasan y el archivo entero se reporta como
  // fallado sin que ningun test haya corrido — un rojo que no dice nada.
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------

describe("el costeador tiene llamador de PRODUCCION", () => {
  it("botar un lote por el RPC de verdad deja su fila de costo, sin que nadie lo pida", async () => {
    const compra = await comprar([linea("PAN DE MOLDE", pollo, 700, 3200)], 3200, "IDEM-BOTAR");
    const lotId = await loteDe(compra);

    // El RPC REAL, el que aprieta la persona. Ni una llamada a
    // app.allocate_movement_cost desde el test: si el enganche no existe,
    // cost_allocations queda vacia y este test se pone rojo.
    await h.como(USER_ANA, () =>
      h.db.query("select public.discard_lot($1, 'SPOILED', 'se puso verde')", [lotId]),
    );

    const asignaciones = await asignacionesDe(lotId);
    expect(asignaciones).toHaveLength(1);
    expect(asignaciones[0]!.category).toBe("WASTED_AVOIDABLE");
    expect(asignaciones[0]!.amount_minor).toBe("3200");
    expect(asignaciones[0]!.value_status).toBe("KNOWN");
    expect(Number(asignaciones[0]!.quantity)).toBe(700);
  });

  it("ninguna salida queda sin costear, y la guarda de integridad no revienta", async () => {
    const filas = await integridad();
    expect(filas.filter((f) => f.tipo === "SALIDA_SIN_COSTEAR")).toEqual([]);
    expect(filas.filter((f) => f.tipo === "LOTE_DESCUADRADO")).toEqual([]);

    const r = await intentar("select app.assert_finance_integrity($1)", [hogar.householdId]);
    expect(r.rechazado).toBe(false);
  });

  it("un lote sin precio produce una salida DESCONOCIDA con motivo, jamas un $0", async () => {
    const lotId = (await h.como(USER_ANA, () =>
      h.fila<{ add_manual_lot: string }>(
        "select public.add_manual_lot($1, 'Sobras del domingo', 400, 'G', null, null, null, null)",
        [hogar.householdId],
      ),
    ))!.add_manual_lot;

    await h.como(USER_ANA, () =>
      h.db.query("select public.discard_lot($1, 'EXPIRED', null)", [lotId]),
    );

    const asignaciones = await asignacionesDe(lotId);
    expect(asignaciones).toHaveLength(1);
    expect(asignaciones[0]!.value_status).toBe("UNKNOWN");
    expect(asignaciones[0]!.amount_minor).toBeNull();
    expect(asignaciones[0]!.unknown_reason).toBe("LOT_VALUE_UNKNOWN");

    // Y el hecho llega hasta donde se mira: la cubeta del periodo lo cuenta como
    // desconocido, no como cero.
    const cubeta = await h.como(USER_ANA, () =>
      h.fila<{ known_minor: string | null; unknown_count: string }>(
        `select known_minor::text as known_minor, unknown_count::text as unknown_count
           from public.finance_period_accruals
          where household_id = $1 and category = 'WASTED_AVOIDABLE'`,
        [hogar.householdId],
      ),
    );
    expect(Number(cubeta!.unknown_count)).toBe(1);
  });

  it("pelar sigue siendo posible: la merma de preparacion se costea como ESPERADA", async () => {
    const compra = await comprar([linea("PAPAS", arroz, 1000, 10000)], 10000, "IDEM-PELAR");
    const lotId = await loteDe(compra);

    const plan = await h.como(USER_ANA, () =>
      h.fila<{ save_prep_plan: string }>(
        `select public.save_prep_plan($1, current_date, 'batch-prep/1.0.0', 1, '{}'::jsonb,
                'PREP:costeo-pelar', $2::jsonb)`,
        [
          hogar.householdId,
          JSON.stringify([
            {
              task_type: "PEEL",
              lot_id: lotId,
              ingredient_id: arroz,
              label: "Pelar papas",
              planned_quantity: 1000,
              unit: "G",
            },
          ]),
        ],
      ),
    );
    const tarea = await h.como(USER_ANA, () =>
      h.fila<{ id: string }>(
        "select id from public.batch_prep_tasks where plan_id = $1 order by seq limit 1",
        [plan!.save_prep_plan],
      ),
    );

    // 1 kg entra, 800 g quedan utilizables, 200 g de cascara. El RPC real, el
    // que aprieta quien cocina. Con `PREP_LOSS` fuera de app.classify_waste
    // esto reventaba con «no se en que categoria de costo va un movimiento
    // PREP_LOSS»: el enganche del ledger le impedia PELAR PAPAS a la casa.
    const r = await intentar(
      "select public.complete_prep_task($1, 1000, $2::jsonb)",
      [tarea!.id, JSON.stringify({ output_quantity: 800, waste_quantity: 200, waste_cause: "PEEL" })],
    );
    expect(r.mensaje).toBeNull();
    expect(r.rechazado).toBe(false);

    const asignaciones = await asignacionesDe(lotId);
    expect(asignaciones).toHaveLength(1);
    // La cascara NO es reproche: es merma ESPERADA, y vale 200 de 1000 g.
    expect(asignaciones[0]!.category).toBe("WASTED_EXPECTED");
    expect(asignaciones[0]!.amount_minor).toBe("2000");
    expect(asignaciones[0]!.value_status).toBe("KNOWN");
  });

  it("ninguna razon del ledger queda sin respuesta: el enum se cubre ENTERO", async () => {
    // LA GUARDA QUE FALTABA. `PREP_LOSS` llego al enum en la 0015 y
    // `LEFTOVER_RETURN` en la 0041, y ninguna de las dos estaba en
    // app.classify_waste: el dia que el ledger empezo a costear solo, pelar
    // papas dejo de funcionar y nadie lo vio porque ningun test aplicaba la
    // 0044 sobre un camino de preparacion.
    //
    // Esta consulta le pregunta a la BASE, no a una lista escrita a mano: por
    // cada valor del enum, o es una TRANSFERENCIA declarada (la comida sigue en
    // la casa), o es una ENTRADA declarada, o tiene categoria de costo. La
    // proxima razon que alguien agregue se pone roja aca, no en la cocina.
    const huerfanas = await h.comoAdmin(() =>
      h.filas<{ reason: string }>(
        `select e.enumlabel as reason
           from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = 'movement_reason'
            and not app.movement_is_value_transfer(e.enumlabel::public.movement_reason)
            and not app.movement_is_inflow_only(e.enumlabel::public.movement_reason)
            and app.classify_waste(e.enumlabel::public.movement_reason) is null
          order by 1`,
      ),
    );
    expect(huerfanas.map((f) => f.reason)).toEqual([]);
  });
});

describe("la despensa BAJA cuando la casa come", () => {
  it("consumir 2 de 5 kilos descuenta su plata del valor guardado", async () => {
    // Se mide el DELTA, no el absoluto: el hogar arrastra lo de los tests
    // anteriores y un absoluto ata este test al orden del archivo.
    const inicial = Number((await despensa())!.known_value_minor);

    const compra = await comprar([linea("POLLO ENTERO", pollo, 5000, 25000)], 25000, "IDEM-POLLO");
    const lotId = await loteDe(compra);

    const antes = await despensa();
    expect(Number(antes!.known_value_minor)).toBe(inicial + 25000);

    // "En realidad quedan 3 kg": el ajuste es una salida real de 2 kg.
    await h.como(USER_ANA, () =>
      h.db.query("select public.adjust_lot($1, 3000, 'pesamos de nuevo')", [lotId]),
    );

    const asignaciones = await asignacionesDe(lotId);
    expect(asignaciones).toHaveLength(1);
    expect(asignaciones[0]!.category).toBe("ADJUSTMENT_LOSS");
    expect(asignaciones[0]!.amount_minor).toBe("10000");

    const despues = await despensa();
    // 25.000 − 10.000. Con el `sum(value_minor)` de antes la despensa no bajaba
    // nunca y el mismo dinero se mostraba dos veces.
    expect(Number(despues!.known_value_minor)).toBe(inicial + 15000);
  });

  it("partir un lote ya consumido reparte el REMANENTE, no lo que costo entero", async () => {
    const compra = await comprar([linea("ARROZ", arroz, 5000, 25000)], 25000, "IDEM-ARROZ");
    const lotId = await loteDe(compra);

    const antesDelSplit = Number((await despensa())!.known_value_minor);

    // Se cocinan 2 kg: quedan 3 kg que valen $15.000.
    await h.como(USER_ANA, () =>
      h.db.query("select public.adjust_lot($1, 3000, 'se cocinaron 2 kg')", [lotId]),
    );
    expect(Number((await despensa())!.known_value_minor)).toBe(antesDelSplit + 15000 - 25000);

    const hijos = await h.como(USER_ANA, () =>
      h.fila<{ split_lot: string }>("select public.split_lot($1, array[1000]::numeric[])::text", [
        lotId,
      ]),
    );
    const hijoId = hijos!.split_lot.replace(/[{}]/g, "").split(",")[0]!;

    // 1 de los 3 kg que quedan: un tercio de $15.000, no un quinto de $25.000.
    expect(Number((await lote(hijoId)).value_minor)).toBe(5000);

    // Y el padre: adquirio 25.000, entrego 5.000, ya tenia 10.000 cargados.
    const padre = await lote(lotId);
    expect(Number(padre.value_minor)).toBe(20000);

    // La despensa vale lo mismo antes y despues de partir: partir no crea plata.
    const total = Number((await despensa())!.known_value_minor);
    expect(total).toBe(antesDelSplit + 15000 - 25000);

    const filas = await integridad();
    expect(filas.filter((f) => f.tipo === "LOTE_DESCUADRADO")).toEqual([]);
  });

  it("unir dos lotes ya consumidos entrega los remanentes y no descuadra a nadie", async () => {
    const c1 = await comprar([linea("FIDEOS A", arroz, 1000, 2000)], 2000, "IDEM-FID-A");
    const c2 = await comprar([linea("FIDEOS B", arroz, 1000, 3000)], 3000, "IDEM-FID-B");
    const a = await loteDe(c1);
    const b = await loteDe(c2);

    // De cada uno se consume la mitad: quedan $1.000 y $1.500.
    await h.como(USER_ANA, async () => {
      await h.db.query("select public.adjust_lot($1, 500, null)", [a]);
      await h.db.query("select public.adjust_lot($1, 500, null)", [b]);
    });

    const nuevo = await h.como(USER_ANA, () =>
      h.fila<{ merge_lots: string }>("select public.merge_lots(array[$1, $2]::uuid[])", [a, b]),
    );

    const unido = await lote(nuevo!.merge_lots);
    expect(unido.value_status).toBe("KNOWN");
    expect(Number(unido.value_minor)).toBe(2500);

    // El origen queda con lo que ya se le habia cargado: remanente CERO. Con el
    // `value_minor = 0` crudo de la v4 esto quedaba en −1.000, la vista lo
    // reportaba como DESCUADRE y app.assert_finance_integrity reventaba para el
    // hogar de ahi en adelante. La guarda va primero, a proposito: es la que
    // tiene que cachar la regresion, no la aritmetica del test.
    const r = await intentar("select app.assert_finance_integrity($1)", [hogar.householdId]);
    expect(r.mensaje).toBeNull();
    expect(r.rechazado).toBe(false);

    expect(Number((await lote(a)).value_minor)).toBe(1000);
    expect(Number((await lote(b)).value_minor)).toBe(1500);
  });
});

describe("plata declarada que nunca entro a un lote", () => {
  it("la linea sin cantidad se DECLARA en vez de saltarse en silencio", async () => {
    const compra = await comprar(
      [
        linea("POLLO EN PRESAS", pollo, 1000, 10000),
        {
          raw_label: "BOLSA DE TE SIN GRAMAJE",
          ingredient_id: arroz,
          line_subtotal_minor: 15000,
        },
      ],
      25000,
      "IDEM-SIN-CANTIDAD",
    );

    // 1) Queda escrito en la auditoria: cuantas lineas y cuanta plata.
    const evento = await h.comoAdmin(() =>
      h.fila<{ metadata: Record<string, unknown> }>(
        `select metadata from public.audit_events
          where subject_id = $1 and action = 'PURCHASE_RECORDED'`,
        [compra],
      ),
    );
    expect(evento!.metadata.lineas_sin_lote).toBe(1);
    expect(Number(evento!.metadata.declarado_sin_lote_minor)).toBe(15000);

    // 2) Y queda a la vista, con su motivo, hasta que alguien la complete.
    const filas = await h.como(USER_ANA, () =>
      h.filas<{ detalle: string; motivo: string; acquired_minor: string | null }>(
        `select detalle, motivo, acquired_minor::text as acquired_minor
           from public.finance_integrity_report
          where household_id = $1 and tipo = 'LINEA_SIN_LOTE'`,
        [hogar.householdId],
      ),
    );
    expect(filas).toHaveLength(1);
    expect(filas[0]!.detalle).toBe("BOLSA DE TE SIN GRAMAJE");
    expect(filas[0]!.motivo).toBe("SIN_CANTIDAD_CANONICA");
    expect(Number(filas[0]!.acquired_minor)).toBe(15000);

    // 3) Y NO se cuenta como valor guardado: capitalizado son los $10.000 que si
    //    entraron, con el resto declarado desconocido en vez de sumado.
    const caja = await h.como(USER_ANA, () =>
      h.fila<{
        declared_total_minor: string;
        capitalized_known_minor: string | null;
        capitalized_unknown_count: string;
      }>(
        `select declared_total_minor::text as declared_total_minor,
                capitalized_known_minor::text as capitalized_known_minor,
                capitalized_unknown_count::text as capitalized_unknown_count
           from public.purchase_cash_summary where purchase_id = $1`,
        [compra],
      ),
    );
    expect(Number(caja!.declared_total_minor)).toBe(25000);
    expect(Number(caja!.capitalized_known_minor)).toBe(10000);
    expect(Number(caja!.capitalized_unknown_count)).toBe(1);
  });
});
