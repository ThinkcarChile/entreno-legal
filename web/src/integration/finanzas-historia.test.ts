import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 14 — PERMISOS, PRIVACIDAD E HISTORIA, contra un Postgres de verdad
 * (PGlite). Cada caso está escrito con LA MUTACIÓN que lo pone rojo al lado:
 *
 *   - `member_id` es QUIEN COMIÓ, no quien apretó el botón. Mutación: volver a
 *     escribir `v_mov.actor_member_id` en `app.allocate_movement_cost`.
 *   - Un RPC que ESCRIBE no se protege con el permiso de SOLO LECTURA.
 *     Mutación: devolver `reconcile_purchase` a FINANCE_VIEW.
 *   - Un período CERRADO no cambia de moneda porque el hogar cambie la suya.
 *     Mutación: devolver `budget_period_summary` a `h.currency`.
 *   - La merma en plata tiene UN dueño. Mutación: devolver `waste_movements` a
 *     `acquisition_value × cantidad / entradas`.
 *
 * POR QUÉ APLICA LAS MIGRACIONES A MANO: `harness.ts` lo comparten varios
 * agentes del mismo sprint y su lista `MIGRACIONES` llega a la 0038. Mismo
 * patrón que `finanzas-compras.test.ts` y `finanzas-panel.test.ts`.
 */

const RAIZ = path.resolve(__dirname, "../../..");
const USER_ANA = "00000000-0000-0000-0000-0000000014c1"; // admin: registra todo
const USER_BETO = "00000000-0000-0000-0000-0000000014c2"; // COME, y tiene FINANCE_VIEW
const USER_CARLA = "00000000-0000-0000-0000-0000000014c3"; // mira la plata del hogar

let h: Harness;
let hogar: { householdId: string; memberId: string };
let betoMemberId: string;
let carlaMemberId: string;
let pollo: string;
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

async function agregarIntegrante(userId: string, email: string, nombre: string): Promise<string> {
  return h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [userId, email]);
    const m = await h.fila<{ id: string }>(
      `insert into public.household_members (household_id, user_id, display_name, birth_date)
       values ($1, $2, $3, '1990-01-01') returning id`,
      [hogar.householdId, userId, nombre],
    );
    return m!.id;
  });
}

/**
 * Un lote con valor conocido, escrito por el dueño único del valor
 * (`app.set_lot_value`, 0042). Sin movimiento de entrada a mano: el trigger
 * `movements_apply` (0011) SUMA el delta al lote, así que insertar la cantidad
 * y además la entrada dejaría el doble de comida.
 */
async function loteConValor(gramos: number, minor: number): Promise<string> {
  return h.comoAdmin(async () => {
    const lote = await h.fila<{ id: string }>(
      `insert into public.inventory_lots
         (household_id, ingredient_id, label, quantity, unit, weight_basis,
          location_id, status, created_by)
       values ($1, $2, 'Pollo', $3, 'G', 'RAW', $4, 'AVAILABLE', $5)
       returning id`,
      [hogar.householdId, pollo, gramos, congelador, hogar.memberId],
    );
    await h.db.query("select app.set_lot_value($1, $2::bigint)", [lote!.id, String(minor)]);
    return lote!.id;
  });
}

/**
 * BETO COME, ANA SIRVE. Por el RPC de produccion (`public.serve_off_plan`), que
 * es el unico camino por el que sale comida al plato desde la 0036: escribe el
 * registro de servido a nombre del COMENSAL y el movimiento con
 * `actor_member_id` = quien lo registro. Un test que insertara el movimiento a
 * mano no probaria nada de esto, porque el reparto de papeles lo hace el RPC.
 */
async function comer(
  loteId: number | string,
  gramos: number,
  comensal: string,
): Promise<{ movementId: string; allocationId: string }> {
  const antes = await h.comoAdmin(() =>
    h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [
      loteId,
    ]),
  );
  await h.como(USER_ANA, () =>
    h.db.query("select public.serve_off_plan($1, $2, $3)", [comensal, loteId, gramos]),
  );
  return h.comoAdmin(async () => {
    const mov = await h.fila<{ id: string }>(
      `select id from public.inventory_movements
        where lot_id = $1 and reason = 'CONSUMED' order by created_at desc limit 1`,
      [loteId],
    );
    // El costeo lo engancha el ledger; si todavia no esta enganchado, se costea
    // aca para que este test mida LA ATRIBUCION y no el enganche del vecino.
    const ya = await h.fila<{ id: string }>(
      "select id from public.cost_allocations where movement_id = $1",
      [mov!.id],
    );
    if (ya !== null) return { movementId: mov!.id, allocationId: ya.id };
    const a = await h.fila<{ allocate_movement_cost: string }>(
      "select app.allocate_movement_cost($1, $2, null, '2026-08-21')",
      [mov!.id, antes!.quantity],
    );
    return { movementId: mov!.id, allocationId: a!.allocate_movement_cost };
  });
}

/** Una merma de despensa por el RPC de verdad: la bota Ana, pero no es de Ana. */
async function botar(loteId: string): Promise<string> {
  const antes = await h.comoAdmin(() =>
    h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [
      loteId,
    ]),
  );
  await h.como(USER_ANA, () =>
    h.db.query("select public.discard_lot($1, 'SPOILED', null)", [loteId]),
  );
  return h.comoAdmin(async () => {
    const mov = await h.fila<{ id: string }>(
      `select id from public.inventory_movements
        where lot_id = $1 and reason = 'SPOILED' order by created_at desc limit 1`,
      [loteId],
    );
    const ya = await h.fila<{ id: string }>(
      "select id from public.cost_allocations where movement_id = $1",
      [mov!.id],
    );
    if (ya === null) {
      await h.db.query("select app.allocate_movement_cost($1, $2, null, '2026-08-21')", [
        mov!.id,
        antes!.quantity,
      ]);
    }
    return mov!.id;
  });
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

  hogar = await crearHogar(h, USER_ANA, "Hogar Historia", "AnaH");
  betoMemberId = await agregarIntegrante(USER_BETO, "beto14c@test.dev", "Beto");
  carlaMemberId = await agregarIntegrante(USER_CARLA, "carla14c@test.dev", "Carla");

  await h.comoAdmin(async () => {
    const ing = await h.fila<{ id: string }>(
      "select id from public.ingredients order by display_name limit 1",
    );
    pollo = ing!.id;
  });

  await h.como(USER_ANA, async () => {
    await h.db.query("select public.ensure_storage_locations($1)", [hogar.householdId]);
    // Beto y Carla ven la plata del hogar. Ninguno de los dos tiene
    // FINANCE_VIEW_MEMBER sobre el otro: eso es lo que se está probando.
    for (const m of [betoMemberId, carlaMemberId]) {
      await h.db.query("select public.grant_finance_access($1, $2, 'FINANCE_VIEW')", [
        hogar.householdId,
        m,
      ]);
    }
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

describe("[BLOQUEANTE] el gasto por integrante es de quien COMIÓ", () => {
  it("Beto come lo que Ana registra, y la asignación queda a nombre de Beto", async () => {
    const lote = await loteConValor(1000, 10000);
    const { allocationId } = await comer(lote, 400, betoMemberId);

    const fila = await h.comoAdmin(() =>
      h.fila<{ member_id: string; amount_minor: string }>(
        "select member_id, amount_minor from public.cost_allocations where id = $1",
        [allocationId],
      ),
    );

    // La mutación exacta que esto ataja: `v_mov.actor_member_id` en vez del
    // comensal. Con ella, member_id sería el de Ana y este expect se cae.
    expect(fila!.member_id).toBe(betoMemberId);
    expect(fila!.member_id).not.toBe(hogar.memberId);
    expect(Number(fila!.amount_minor)).toBe(4000);
  });

  it("Beto ve SU propio gasto; Carla, que tiene FINANCE_VIEW, no lo ve", async () => {
    const lote = await loteConValor(1000, 20000);
    const { allocationId } = await comer(lote, 500, betoMemberId);

    const deBeto = await h.como(USER_BETO, () =>
      h.filas("select id from public.cost_allocations where id = $1", [allocationId]),
    );
    const deCarla = await h.como(USER_CARLA, () =>
      h.filas("select id from public.cost_allocations where id = $1", [allocationId]),
    );

    // Sin el arreglo, la fila lleva el member_id de Ana: Beto —que es quien
    // comió— NO puede ver su propio gasto, y el permiso de privacidad protege a
    // la persona equivocada. Con el arreglo, cada quien ve lo suyo.
    expect(deBeto).toHaveLength(1);
    expect(deCarla).toHaveLength(0);
  });

  it("la merma es del hogar: nadie carga con lo que se echó a perder", async () => {
    const lote = await loteConValor(1000, 8000);
    const mov = await botar(lote);

    const fila = await h.comoAdmin(() =>
      h.fila<{ member_id: string | null; category: string }>(
        "select member_id, category from public.cost_allocations where movement_id = $1",
        [mov],
      ),
    );
    expect(fila!.category).toBe("WASTED_AVOIDABLE");
    expect(fila!.member_id).toBeNull();

    // Y por eso la ve todo el que tiene FINANCE_VIEW: es un agregado del hogar.
    const deCarla = await h.como(USER_CARLA, () =>
      h.filas("select id from public.cost_allocations where movement_id = $1", [mov]),
    );
    expect(deCarla).toHaveLength(1);
  });

  it("la base RECHAZA una asignación atribuida a quien no comió", async () => {
    const lote = await loteConValor(1000, 5000);
    const { movementId } = await comer(lote, 100, betoMemberId);

    // El escritor viejo, escrito a mano: el registrador en la columna del
    // comensal. La guarda vive en la BASE, no en la disciplina del llamador —
    // que es lo que hace que el próximo camino de salida no pueda repetir el
    // error en silencio.
    const r = await intentar(
      `insert into public.cost_allocations
         (household_id, movement_id, lot_id, category, currency, amount_minor,
          value_status, unknown_reason, quantity, cost_basis_snapshot, engine_version,
          occurred_on, recognized_on, member_id)
       select $1, $2, m.lot_id, 'CORRECTION', 'CLP', 1,
              'KNOWN', null, 1, '{}'::jsonb, 'test', '2026-08-21', '2026-08-21', $3
         from public.inventory_movements m where m.id = $2`,
      [hogar.householdId, movementId, hogar.memberId],
    );
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toMatch(/QUIEN COMIÓ/i);
  });
});

describe("[ALTO] un RPC que escribe no se protege con el permiso de solo lectura", () => {
  it("Carla, con FINANCE_VIEW, no puede reconciliar una compra", async () => {
    const compra = await h.como(USER_ANA, () =>
      h.fila<{ record_purchase: string }>(
        `select public.record_purchase($1, 'SUPERMARKET', 'Súper', null, '2026-08-20',
                10003::bigint, 'PRINTED', $2::jsonb, '[]'::jsonb, null, 'historia-recon')`,
        [
          hogar.householdId,
          JSON.stringify([
            {
              raw_label: "POLLO",
              ingredient_id: pollo,
              quantity: 1000,
              unit: "G",
              weight_basis: "RAW",
              line_subtotal_minor: 10000,
            },
          ]),
        ],
      ),
    );

    const antes = await h.comoAdmin(() =>
      h.fila<{ reconciled_at: string }>(
        "select reconciled_at from public.purchases where id = $1",
        [compra!.record_purchase],
      ),
    );

    const r = await h.como(USER_CARLA, () =>
      intentar("select public.reconcile_purchase($1)", [compra!.record_purchase]),
    );
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toMatch(/no autorizado/i);

    // Y no movió nada: el cierre de una compra ya conciliada sigue igual.
    const despues = await h.comoAdmin(() =>
      h.fila<{ reconciled_at: string }>(
        "select reconciled_at from public.purchases where id = $1",
        [compra!.record_purchase],
      ),
    );
    expect(String(despues!.reconciled_at)).toBe(String(antes!.reconciled_at));

    // Ana, que sí puede confirmar compras, la reconcilia y queda el rastro.
    const ok = await h.como(USER_ANA, () =>
      intentar("select public.reconcile_purchase($1)", [compra!.record_purchase]),
    );
    expect(ok.rechazado).toBe(false);
  });

  it("reconciliar una compra CERRADA no borra el devengo del cargo de redondeo", async () => {
    const compra = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "select id from public.purchases where idempotency_key = 'historia-recon'",
      ),
    );
    const cargo = await h.comoAdmin(() =>
      h.fila<{ id: string; amount_minor: string }>(
        "select id, amount_minor from public.purchase_charges where purchase_id = $1 and kind = 'ROUNDING'",
        [compra!.id],
      ),
    );
    expect(Number(cargo!.amount_minor)).toBe(3);

    // El devengo del cargo, como lo escribiría `app.allocate_purchase_expense`.
    await h.comoAdmin(() =>
      h.db.query("select app.allocate_purchase_expense($1)", [compra!.id]),
    );
    const asignacion = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        "select id from public.cost_allocations where purchase_charge_id = $1",
        [cargo!.id],
      ),
    );
    expect(asignacion).not.toBeNull();

    // La puerta de atrás del append-only: borrar el cargo arrastraba la
    // asignación por el `on delete cascade` y el `pg_trigger_depth() > 1`.
    const r = await intentar("delete from public.purchase_charges where id = $1", [cargo!.id]);
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toMatch(/ya está reconocido como gasto/i);

    const sigue = await h.comoAdmin(() =>
      h.filas("select id from public.cost_allocations where purchase_charge_id = $1", [cargo!.id]),
    );
    expect(sigue).toHaveLength(1);

    // Cambiarle el monto tampoco: dejaría cargo y devengo diciendo cosas distintas.
    const r2 = await intentar(
      "update public.purchase_charges set amount_minor = 999 where id = $1",
      [cargo!.id],
    );
    expect(r2.rechazado).toBe(true);
    expect(r2.mensaje).toMatch(/ya está reconocido como gasto/i);
  });

  it("estimar precios de una lista escribe, y pide el permiso de precios", async () => {
    const lista = await h.comoAdmin(async () => {
      const plan = await h.fila<{ id: string }>(
        `insert into public.weekly_plans (household_id, week_start, created_by)
         values ($1, '2026-08-17', $2) returning id`,
        [hogar.householdId, hogar.memberId],
      );
      return h.fila<{ id: string }>(
        `insert into public.shopping_lists (household_id, plan_id, created_by)
         values ($1, $2, $3) returning id`,
        [hogar.householdId, plan!.id, hogar.memberId],
      );
    });
    const r = await h.como(USER_CARLA, () =>
      intentar("select public.estimate_shopping_list_prices($1)", [lista!.id]),
    );
    expect(r.rechazado).toBe(true);
    expect(r.mensaje).toMatch(/no autorizado/i);
  });
});

describe("[ALTO] un período cerrado no cambia de significado", () => {
  it("cambiar la moneda del hogar no reinterpreta un período ya cerrado", async () => {
    const antes = await h.como(USER_ANA, () =>
      h.filas<{ currency: string; cash_known_minor: string }>(
        `select currency, cash_known_minor from public.budget_period_summary
          where household_id = $1 and starts_on = '2026-08-01'`,
        [hogar.householdId],
      ),
    );
    expect(antes).toHaveLength(1);
    expect(antes[0]!.currency).toBe("CLP");
    expect(Number(antes[0]!.cash_known_minor)).toBe(10003);

    // El ataque exacto, con el admin del hogar y bajo RLS.
    const cambio = await h.como(USER_ANA, () =>
      intentar("update public.households set currency = 'USD' where id = $1", [hogar.householdId]),
    );
    expect(cambio.rechazado).toBe(true);
    expect(cambio.mensaje).toMatch(/ya tiene plata registrada/i);

    // Y aunque la moneda del hogar cambiara por un camino privilegiado, el
    // período conserva la suya: sale de las filas, no de la configuración.
    await h.comoAdmin(() =>
      h.db.query("alter table public.households disable trigger households_currency_frozen"),
    );
    await h.comoAdmin(() =>
      h.db.query("update public.households set currency = 'USD' where id = $1", [
        hogar.householdId,
      ]),
    );
    const despues = await h.como(USER_ANA, () =>
      h.filas<{ currency: string; cash_known_minor: string }>(
        `select currency, cash_known_minor from public.budget_period_summary
          where household_id = $1 and starts_on = '2026-08-01'`,
        [hogar.householdId],
      ),
    );
    expect(despues).toHaveLength(1);
    expect(despues[0]!.currency).toBe("CLP");
    expect(Number(despues[0]!.cash_known_minor)).toBe(10003);

    // Se deja como estaba, todavía con la guarda apagada, y recién ahí se
    // vuelve a encender: los tests que siguen usan pesos.
    await h.comoAdmin(async () => {
      await h.db.query("update public.households set currency = 'CLP' where id = $1", [
        hogar.householdId,
      ]);
      await h.db.query("alter table public.households enable trigger households_currency_frozen");
    });
  });
});

describe("[ALTO] la merma en plata tiene UN solo dueño", () => {
  it("waste_movements lee el devengo, no una estimación paralela", async () => {
    const lote = await loteConValor(2000, 12000);
    const mov = await botar(lote);

    const fila = await h.comoAdmin(() =>
      h.fila<{ quantity: string; estimated_cost: string | null; waste_kind: string }>(
        "select quantity, estimated_cost, waste_kind from public.waste_movements where id = $1",
        [mov],
      ),
    );
    expect(Number(fila!.quantity)).toBe(2000);
    expect(fila!.waste_kind).toBe("INVENTORY");

    const asignada = await h.comoAdmin(() =>
      h.fila<{ amount_minor: string }>(
        "select amount_minor from public.cost_allocations where movement_id = $1",
        [mov],
      ),
    );
    // El lote entero: $12.000. Lo que separa a esta cifra de la estimación
    // vieja no es el número, es de DÓNDE sale — y por eso el que manda es el
    // devengo, que es el mismo que ve el panel.
    expect(Number(asignada!.amount_minor)).toBe(12000);
    expect(Number(fila!.estimated_cost)).toBe(12000);
  });

  it("la merma del PLATO vale DESCONOCIDO, no un costo inventado", async () => {
    const lote = await loteConValor(1000, 9000);
    await comer(lote, 400, betoMemberId);
    const item = await h.comoAdmin(() =>
      h.fila<{ id: string }>(
        `select i.id from public.meal_serving_record_items i
           join public.meal_serving_records r on r.id = i.record_id
          where r.household_id = $1 order by i.created_at desc limit 1`,
        [hogar.householdId],
      ),
    );
    // Se sirvieron 400 g y 150 quedaron en el plato: eso se bota SIN volver a
    // descontar del lote (delta 0), así que nadie lo costea.
    await h.como(USER_ANA, () =>
      h.db.query("select public.discard_serving($1, $2, 'quedó en el plato')", [item!.id, 150]),
    );

    const fila = await h.comoAdmin(() =>
      h.fila<{ quantity: string; waste_kind: string; estimated_cost: string | null }>(
        `select quantity, waste_kind, estimated_cost from public.waste_movements
          where household_id = $1 and waste_kind = 'SERVING' order by created_at desc limit 1`,
        [hogar.householdId],
      ),
    );
    expect(fila).not.toBeNull();
    expect(Number(fila!.quantity)).toBe(150);
    // El estimador viejo imprimía acá un número sacado de `acquisition_value`
    // —$1.350— para una salida que el libro mayor nunca costeó. DESCONOCIDO no
    // es cero y tampoco es una cuenta hecha con otro modelo contable.
    expect(fila!.estimated_cost).toBeNull();
  });

  it("quien no tiene FINANCE_VIEW ve la merma en cantidad y el costo en DESCONOCIDO", async () => {
    const lote = await loteConValor(1000, 6000);
    const mov = await botar(lote);

    // Dani entra al hogar sin ningún permiso financiero.
    const DANI = "00000000-0000-0000-0000-0000000014c4";
    await agregarIntegrante(DANI, "dani14c@test.dev", "Dani");

    const fila = await h.como(DANI, () =>
      h.fila<{ quantity: string; estimated_cost: string | null }>(
        "select quantity, estimated_cost from public.waste_movements where id = $1",
        [mov],
      ),
    );
    expect(fila).not.toBeNull();
    expect(Number(fila!.quantity)).toBe(1000);
    expect(fila!.estimated_cost).toBeNull();

    // Y la despensa completa se sigue viendo: el cierre por columna de la 0048
    // no puede romper la pantalla de quien no mira plata.
    const lotes = await h.como(DANI, () =>
      h.filas("select id, quantity from public.inventory_lots where household_id = $1", [
        hogar.householdId,
      ]),
    );
    expect(lotes.length).toBeGreaterThan(0);
  });
});
