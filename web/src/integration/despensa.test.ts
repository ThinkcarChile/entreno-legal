import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekStart } from "@/domain/nutrition/calendar";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Integración del Sprint 7 — despensa e inventario sobre PostgreSQL real.
 *
 * K-11: el stock es un libro mayor sobre lotes. Acá se prueba lo que el
 * dominio no puede garantizar solo: append-only, invariantes de grupo,
 * idempotencia de recepción y consumo (K-22), estados térmicos (K-18),
 * conservación de valor en split (K-19) y RLS con rol authenticated.
 */

const USER_A = "00000000-0000-0000-0000-0000000000a7";
const USER_B = "00000000-0000-0000-0000-0000000000b7";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };
let versionPollo: string;
let perfilA: string;
let planA: string;
let almuerzoA: string;
let listaA: string;
let polloId: string;

const SEMANA = weekStart("2026-09-28");
const LUNES = "2026-09-28";

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar Despensa A", "Fran");
  hogarB = await crearHogar(h, USER_B, "Hogar Despensa B", "Vecino");

  versionPollo = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;
  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;

  await h.como(USER_A, async () => {
    perfilA = (await h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', 'firma-despensa-a', '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'despensa')`,
      [hogarA.memberId],
    ))!.publish_nutrition_profile;

    planA = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, $2)",
      [hogarA.householdId, SEMANA],
    ))!.ensure_weekly_plan;

    const dia = (await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
      [planA, LUNES],
    ))!.id;

    almuerzoA = (await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
       select $1, 'LUNCH', 'RECIPE', v.template_id, v.id
       from public.meal_template_versions v where v.id = $2
       returning id`,
      [dia, versionPollo],
    ))!.id;

    // Comida confirmada: 1 porción de 180 g de pollo.
    await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
      almuerzoA,
      JSON.stringify([
        {
          member_id: hogarA.memberId,
          version_id: versionPollo,
          profile_id: perfilA,
          optimizer_version: "portion-optimizer/1.0.0",
          meal_type: "LUNCH",
          serving_date: LUNES,
          fit: "COMPATIBLE",
          adaptation_level: 0,
          score: 90,
          nutrition: { energy_kcal: 500 },
          completeness: { energy_kcal: "COMPLETE" },
          reasons: [],
          unmet_constraints: [],
          components: [
            {
              label: "Pechuga de pollo (sin piel)",
              base_quantity: 180,
              proposed_quantity: 180,
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
      ]),
    ]);

    // Lista con pollo comprado y finalizada.
    listaA = (await h.fila<{ id: string }>(
      `insert into public.shopping_lists (household_id, plan_id, created_by, status)
       values ($1, $2, $3, 'ACTIVE') returning id`,
      [hogarA.householdId, planA, hogarA.memberId],
    ))!.id;
    await h.db.query(
      `select public.generate_shopping_revision($1, 'firma-d1', 'shopping-engine/1.0.0', '[]'::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        listaA,
        JSON.stringify([
          {
            line_key: "k-pollo",
            ingredient_id: polloId,
            product_id: null,
            label: "Pechuga de pollo (sin piel)",
            unit: "G",
            required_quantity: 500,
            purchase_basis: "RAW",
            cooked_quantity: null,
            yield_factor: null,
            unresolved: false,
            unresolved_reason: null,
            provenance: [],
          },
        ]),
      ],
    );
    await h.db.query(
      "update public.shopping_list_items set status = 'PURCHASED' where list_id = $1 and line_key = 'k-pollo'",
      [listaA],
    );
    // Item manual SIN identidad de alimento: no debe volverse lote.
    await h.db.query(
      `insert into public.shopping_list_items (list_id, source, label, unit, planned_quantity, purchase_basis, status)
       values ($1, 'MANUAL', 'Detergente', 'UNIT', 1, 'OTHER', 'PURCHASED')`,
      [listaA],
    );
  });
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------
describe("recepción de la compra", () => {
  it("con la lista ACTIVE se rechaza: se recibe lo comprado, no lo pendiente", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.receive_shopping_list($1, null)", [listaA]),
      ),
    ).rejects.toThrow(/finaliza/i);
  });

  it("con la lista COMPLETED crea lotes desde lo COMPRADO, con identidad", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("update public.shopping_lists set status = 'COMPLETED' where id = $1", [
        listaA,
      ]);
    });
    const n = await h.como(USER_A, () =>
      h.fila<{ receive_shopping_list: number }>(
        "select public.receive_shopping_list($1, null)",
        [listaA],
      ),
    );
    expect(Number(n!.receive_shopping_list)).toBe(1); // el detergente NO entra

    const lotes = await h.como(USER_A, () =>
      h.filas<{ label: string; quantity: string; ingredient_id: string; status: string }>(
        "select label, quantity, ingredient_id, status from public.inventory_lots where household_id = $1",
        [hogarA.householdId],
      ),
    );
    expect(lotes).toHaveLength(1);
    expect(Number(lotes[0]!.quantity)).toBe(500);
    expect(lotes[0]!.ingredient_id).toBe(polloId);
    expect(lotes[0]!.status).toBe("AVAILABLE");
  });

  it("K-22: recibir de nuevo es un no-op, jamás duplica", async () => {
    const n = await h.como(USER_A, () =>
      h.fila<{ receive_shopping_list: number }>(
        "select public.receive_shopping_list($1, null)",
        [listaA],
      ),
    );
    expect(Number(n!.receive_shopping_list)).toBe(0);
    const lotes = await h.como(USER_A, () =>
      h.filas("select 1 from public.inventory_lots where household_id = $1", [hogarA.householdId]),
    );
    expect(lotes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("el libro mayor manda", () => {
  let lote: string;

  it("la cantidad del lote es la suma de sus movimientos", async () => {
    lote = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.inventory_lots where household_id = $1",
        [hogarA.householdId],
      ),
    ))!.id;
    const movs = await h.como(USER_A, () =>
      h.fila<{ suma: string }>(
        "select sum(delta) as suma from public.inventory_movements where lot_id = $1",
        [lote],
      ),
    );
    expect(Number(movs!.suma)).toBe(500);
  });

  it("append-only: editar o borrar un movimiento explota", async () => {
    await expect(
      h.comoAdmin(() =>
        h.db.query("update public.inventory_movements set delta = 999 where lot_id = $1", [lote]),
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      h.comoAdmin(() =>
        h.db.query("delete from public.inventory_movements where lot_id = $1", [lote]),
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it("el inventario no queda negativo: un movimiento imposible se rechaza", async () => {
    // El INVARIANTE no cambió: un movimiento que dejaría el lote bajo cero se
    // rechaza. Lo que cambió (0036) es el camino para llegar hasta esa pared:
    // un CONSUMED suelto ya lo rebota antes el candado del dueño ("primero se
    // sirve, después se descuenta"), así que probar con él dejaría de probar
    // que la pared del inventario sigue en pie. Acá se llega hasta ella por el
    // camino NUEVO: un renglón servido legítimo del hogar, que sirvió 9.999 y
    // por lo tanto autoriza descontar 9.999 — y el lote, que tiene 500, no los
    // puede pagar.
    //
    // Todo en UN solo `do` (una transacción): el registro de servido nace y
    // muere con el intento, así que este test no le deja nada a los que siguen.
    await expect(
      h.comoAdmin(() =>
        h.db.query(`
          do $$
          declare v_record uuid; v_item uuid;
          begin
            insert into public.meal_serving_records
              (household_id, member_id, kind, served_on)
            values ('${hogarA.householdId}', '${hogarA.memberId}', 'OFF_PLAN', current_date)
            returning id into v_record;

            insert into public.meal_serving_record_items
              (record_id, label, served_quantity, served_unit, served_weight_basis,
               served_quantity_is_declared)
            values (v_record, 'Pollo imposible', 9999, 'G', 'RAW', true)
            returning id into v_item;

            insert into public.inventory_movements
              (household_id, lot_id, reason, delta, serving_record_item_id, covers_quantity)
            values ('${hogarA.householdId}', '${lote}', 'CONSUMED', -9999, v_item, -9999);
          end $$;
        `),
      ),
    ).rejects.toThrow(/negativo/i);
  });

  it("ajustar es un movimiento auditado, no una edición", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("select public.adjust_lot($1, 450, 'pesé el paquete')", [lote]);
    });
    const lot = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [
        lote,
      ]),
    );
    expect(Number(lot!.quantity)).toBe(450);
    const mov = await h.como(USER_A, () =>
      h.fila<{ delta: string; notes: string; actor_member_id: string }>(
        `select delta, notes, actor_member_id from public.inventory_movements
         where lot_id = $1 and reason = 'ADJUSTMENT'`,
        [lote],
      ),
    );
    expect(Number(mov!.delta)).toBe(-50);
    expect(mov!.notes).toBe("pesé el paquete");
    expect(mov!.actor_member_id).toBe(hogarA.memberId);
  });
});

// ---------------------------------------------------------------------------
describe("split: la cantidad y el valor se conservan (K-11, K-19)", () => {
  it("partir 450 g en 3 conserva el total y reparte el valor", async () => {
    const lote = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.inventory_lots where household_id = $1 and parent_lot_id is null",
        [hogarA.householdId],
      ),
    ))!.id;
    // Dale un valor para probar K-19.
    await h.comoAdmin(async () => {
      await h.db.query("update public.inventory_lots set acquisition_value = 4500 where id = $1", [
        lote,
      ]);
    });

    await h.como(USER_A, async () => {
      await h.db.query("select public.split_lot($1, array[150, 150, 150]::numeric[])", [lote]);
    });

    // Se lee como DUENA, no como USER_A: la 0048 le cierra a `authenticated` la
    // lectura del dinero del lote —columna por columna— y lo desvia a la vista
    // `lot_valuations`, que exige FINANCE_VIEW. Esta prueba no comprueba quien
    // puede ver el precio; comprueba la FISICA de K-19: que al partir un lote el
    // valor se reparta y el total se conserve. Esa es una propiedad de los
    // datos, no de lo que alcanza a ver un integrante.
    const familia = await h.comoAdmin(() =>
      h.filas<{ quantity: string; acquisition_value: string | null; parent_lot_id: string | null }>(
        `select quantity, acquisition_value, parent_lot_id from public.inventory_lots
         where household_id = $1 order by created_at`,
        [hogarA.householdId],
      ),
    );
    const total = familia.reduce((acc, l) => acc + Number(l.quantity), 0);
    expect(total).toBe(450); // Σ conservada
    const hijos = familia.filter((l) => l.parent_lot_id !== null);
    expect(hijos).toHaveLength(3);
    // K-19: el VALOR se reparte proporcional (450 g valían 4500 → 150 g = 1500)
    // y el PADRE queda debitado: la despensa completa vale lo mismo que antes.
    for (const hijo of hijos) expect(Number(hijo.acquisition_value)).toBe(1500);
    const padre = familia.find((l) => l.parent_lot_id === null)!;
    expect(Number(padre.acquisition_value)).toBe(0);
    const valorTotal = familia.reduce((acc, l) => acc + Number(l.acquisition_value ?? 0), 0);
    expect(valorTotal).toBe(4500);
  });

  it("el padre vaciado por partición queda SPLIT, no CONSUMED: nadie se lo comió", async () => {
    // Como DUENA: `acquisition_value` esta en el WHERE, y filtrar por una columna
    // tambien exige poder leerla. La 0048 se la cierra a `authenticated`, asi que
    // como USER_A esto muere con "permission denied for table inventory_lots"
    // aunque la columna del SELECT sea otra.
    const padre = await h.comoAdmin(() =>
      h.fila<{ status: string }>(
        `select status from public.inventory_lots
         where household_id = $1 and parent_lot_id is null and quantity = 0
           and acquisition_value = 0`,
        [hogarA.householdId],
      ),
    );
    expect(padre!.status).toBe("SPLIT");
  });

  it("partir sin partes o un lote no disponible se rechaza", async () => {
    const hijo = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.inventory_lots where household_id = $1 and parent_lot_id is not null limit 1",
        [hogarA.householdId],
      ),
    ))!.id;
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.split_lot($1, array[]::numeric[])", [hijo]),
      ),
    ).rejects.toThrow(/al menos una parte/i);

    const cerrado = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.inventory_lots where household_id = $1 and status = 'SPLIT' limit 1",
        [hogarA.householdId],
      ),
    ))!.id;
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.split_lot($1, array[10]::numeric[])", [cerrado]),
      ),
    ).rejects.toThrow(/disponible/i);
  });

  it("partir más de lo que hay se rechaza: partir no crea comida", async () => {
    const hijo = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.inventory_lots where household_id = $1 and parent_lot_id is not null limit 1",
        [hogarA.householdId],
      ),
    ))!.id;
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.split_lot($1, array[9999]::numeric[])", [hijo]),
      ),
    ).rejects.toThrow(/no crea comida/i);
  });

  it("un grupo SPLIT desbalanceado viola el invariante al cierre", async () => {
    const lote = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.inventory_lots where household_id = $1 and quantity > 0 limit 1",
        [hogarA.householdId],
      ),
    ))!.id;
    await expect(
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements (household_id, lot_id, reason, delta, group_id)
           values ($1, $2, 'SPLIT', -10, gen_random_uuid())`,
          [hogarA.householdId, lote],
        ),
      ),
    ).rejects.toThrow(/invariante/i);
  });
});

// ---------------------------------------------------------------------------
describe("K-18: mover al congelador y de vuelta", () => {
  let lote: string;
  let congelador: string;
  let refri: string;

  it("congelador → FROZEN, sin tocar cantidad", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("select public.ensure_storage_locations($1)", [hogarA.householdId]);
    });
    congelador = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.storage_locations where household_id = $1 and kind = 'FREEZER'",
        [hogarA.householdId],
      ),
    ))!.id;
    refri = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.storage_locations where household_id = $1 and kind = 'FRIDGE'",
        [hogarA.householdId],
      ),
    ))!.id;
    lote = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.inventory_lots where household_id = $1 and quantity > 0 limit 1",
        [hogarA.householdId],
      ),
    ))!.id;

    await h.como(USER_A, async () => {
      await h.db.query("select public.move_lot($1, $2)", [lote, congelador]);
    });
    const l = await h.como(USER_A, () =>
      h.fila<{ temperature_state: string; thawed_at: string | null; quantity: string }>(
        "select temperature_state, thawed_at, quantity from public.inventory_lots where id = $1",
        [lote],
      ),
    );
    expect(l!.temperature_state).toBe("FROZEN");
    expect(l!.thawed_at).toBeNull();
    expect(Number(l!.quantity)).toBe(150);
  });

  it("sacar del congelador sella thawed_at como EVIDENCIA, no prohibición", async () => {
    await h.como(USER_A, async () => {
      await h.db.query("select public.move_lot($1, $2)", [lote, refri]);
    });
    const l = await h.como(USER_A, () =>
      h.fila<{ temperature_state: string; thawed_at: string | null }>(
        "select temperature_state, thawed_at from public.inventory_lots where id = $1",
        [lote],
      ),
    );
    expect(l!.temperature_state).toBe("CHILLED");
    expect(l!.thawed_at).not.toBeNull();

    const thaw = await h.como(USER_A, () =>
      h.fila("select 1 from public.inventory_movements where lot_id = $1 and reason = 'THAW'", [
        lote,
      ]),
    );
    expect(thaw).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("comimos lo planificado", () => {
  it("porciones a SERVED + registro de servido + descuento FEFO capado al stock", async () => {
    const antes = await h.como(USER_A, () =>
      h.fila<{ total: string }>(
        "select sum(quantity) as total from public.inventory_lots where household_id = $1 and ingredient_id = $2",
        [hogarA.householdId, polloId],
      ),
    );
    const n = await h.como(USER_A, () =>
      h.fila<{ consume_planned_meal: { servings: number } }>(
        "select public.consume_planned_meal($1)",
        [almuerzoA],
      ),
    );
    expect(n!.consume_planned_meal.servings).toBe(1);

    // Porción SERVED, registro de servido único, y 180 g menos de pollo (había
    // stock). CONTRATO NUEVO (0036): servir no es comer. La porción llega hasta
    // SERVED y ahí se detiene; quién comió y cuánto lo declara una persona.
    const porcion = await h.como(USER_A, () =>
      h.fila<{ status: string }>(
        "select status from public.member_serving_projections where assignment_id = $1",
        [almuerzoA],
      ),
    );
    expect(porcion!.status).toBe("SERVED");

    // El REGISTRO sigue siendo único — lo que cambió es cuál: el acto físico
    // vive en meal_serving_records, no en un consumption_log que nadie declaró.
    const registro = await h.como(USER_A, () =>
      h.filas<{ id: string; kind: string; status: string }>(
        `select id, kind::text as kind, status from public.meal_serving_records
         where assignment_id = $1`,
        [almuerzoA],
      ),
    );
    expect(registro).toHaveLength(1);
    expect(registro[0]!.kind).toBe("FROM_PLAN");
    expect(registro[0]!.status).toBe("ACTIVE");

    // Y NADIE fabrica un consumo declarado: el eje REAL queda vacío hasta que
    // una persona lo diga. VACÍO ≠ CERO, y por eso se afirma explícito.
    const log = await h.como(USER_A, () =>
      h.filas("select 1 from public.consumption_logs where assignment_id = $1", [almuerzoA]),
    );
    expect(log).toHaveLength(0);

    // El renglón servido congela el plan (180) y dice, sin ambigüedad, cuánto
    // salió de verdad de la despensa: servido = descontado + faltante.
    const renglon = await h.como(USER_A, () =>
      h.fila<{
        planned_quantity: string; served_quantity: string;
        deducted_quantity: string; shortfall_quantity: string;
      }>(
        `select planned_quantity, served_quantity, deducted_quantity, shortfall_quantity
         from public.meal_serving_record_items where record_id = $1`,
        [registro[0]!.id],
      ),
    );
    expect(Number(renglon!.planned_quantity)).toBe(180);
    expect(Number(renglon!.served_quantity)).toBe(180);
    expect(Number(renglon!.deducted_quantity)).toBe(180);
    expect(Number(renglon!.shortfall_quantity)).toBe(0);

    const despues = await h.como(USER_A, () =>
      h.fila<{ total: string }>(
        "select sum(quantity) as total from public.inventory_lots where household_id = $1 and ingredient_id = $2",
        [hogarA.householdId, polloId],
      ),
    );
    expect(Number(antes!.total) - Number(despues!.total)).toBe(180);

    const asig = await h.como(USER_A, () =>
      h.fila<{ status: string }>("select status from public.meal_assignments where id = $1", [
        almuerzoA,
      ]),
    );
    expect(asig!.status).toBe("SERVED");
  });

  it("K-22: registrar de nuevo es un no-op — ni doble log ni doble descuento", async () => {
    const antes = await h.como(USER_A, () =>
      h.fila<{ total: string }>(
        "select sum(quantity) as total from public.inventory_lots where household_id = $1 and ingredient_id = $2",
        [hogarA.householdId, polloId],
      ),
    );
    const n = await h.como(USER_A, () =>
      h.fila<{ consume_planned_meal: { servings: number } }>(
        "select public.consume_planned_meal($1)",
        [almuerzoA],
      ),
    );
    expect(n!.consume_planned_meal.servings).toBe(0);
    const despues = await h.como(USER_A, () =>
      h.fila<{ total: string }>(
        "select sum(quantity) as total from public.inventory_lots where household_id = $1 and ingredient_id = $2",
        [hogarA.householdId, polloId],
      ),
    );
    expect(despues!.total).toBe(antes!.total);
  });

  it("§13 del Sprint 5 sigue vivo: una comida consumida no se reconfirma", async () => {
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.confirm_meal_assignment($1, '[]'::jsonb)", [almuerzoA]),
      ),
    ).rejects.toThrow(/ya se sirvió/i);
  });
});

// ---------------------------------------------------------------------------
describe("merma", () => {
  it("descartar exige causa y deja el lote DISCARDED con su movimiento", async () => {
    const lote = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.inventory_lots where household_id = $1 and quantity > 0 limit 1",
        [hogarA.householdId],
      ),
    ))!.id;

    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.discard_lot($1, 'ADJUSTMENT', null)", [lote]),
      ),
    ).rejects.toThrow(/causa de merma/i);

    await h.como(USER_A, async () => {
      await h.db.query("select public.discard_lot($1, 'SPOILED', null)", [lote]);
    });
    const l = await h.como(USER_A, () =>
      h.fila<{ status: string; quantity: string }>(
        "select status, quantity from public.inventory_lots where id = $1",
        [lote],
      ),
    );
    expect(l!.status).toBe("DISCARDED");
    expect(Number(l!.quantity)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("un lote cerrado es historia", () => {
  it("mover o ajustar un lote SPLIT/DISCARDED se rechaza en vez de reetiquetarlo", async () => {
    const cerrado = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.inventory_lots where household_id = $1 and status in ('SPLIT', 'DISCARDED') limit 1",
        [hogarA.householdId],
      ),
    ))!.id;
    const refri = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.storage_locations where household_id = $1 and kind = 'FRIDGE'",
        [hogarA.householdId],
      ),
    ))!.id;

    await expect(
      h.como(USER_A, () => h.db.query("select public.move_lot($1, $2)", [cerrado, refri])),
    ).rejects.toThrow(/cerrado/i);
    await expect(
      h.como(USER_A, () => h.db.query("select public.adjust_lot($1, 5, null)", [cerrado])),
    ).rejects.toThrow(/cerrado/i);

    // El status no cambió: la merma/partición sigue diciendo la verdad.
    const l = await h.como(USER_A, () =>
      h.fila<{ status: string }>("select status from public.inventory_lots where id = $1", [
        cerrado,
      ]),
    );
    expect(["SPLIT", "DISCARDED"]).toContain(l!.status);
  });

  it("NaN no atraviesa las guardas numéricas", async () => {
    const abierto = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.inventory_lots where household_id = $1 and status = 'AVAILABLE' limit 1",
        [hogarA.householdId],
      ),
    ))!.id;
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.adjust_lot($1, 'NaN'::numeric, null)", [abierto]),
      ),
    ).rejects.toThrow(/válido/i);
  });

  it("una ubicación con lotes adentro no se borra", async () => {
    const conLotes = (await h.como(USER_A, () =>
      h.fila<{ location_id: string }>(
        "select location_id from public.inventory_lots where household_id = $1 and status = 'AVAILABLE' and location_id is not null limit 1",
        [hogarA.householdId],
      ),
    ))!.location_id;
    await expect(
      h.como(USER_A, () =>
        h.db.query("delete from public.storage_locations where id = $1", [conLotes]),
      ),
    ).rejects.toThrow(/muévelos/i);
  });
});

// ---------------------------------------------------------------------------
describe("RLS: la despensa del hogar A es invisible e intocable para el B", () => {
  it("no lee lotes ni movimientos", async () => {
    const lotes = await h.como(USER_B, () =>
      h.filas("select 1 from public.inventory_lots where household_id = $1", [hogarA.householdId]),
    );
    expect(lotes).toHaveLength(0);
    const movs = await h.como(USER_B, () =>
      h.filas("select 1 from public.inventory_movements where household_id = $1", [
        hogarA.householdId,
      ]),
    );
    expect(movs).toHaveLength(0);
  });

  it("no puede recibir la lista del A ni ajustar sus lotes", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query("select public.receive_shopping_list($1, null)", [listaA]),
      ),
    ).rejects.toThrow(/no autorizado|inexistente/i);

    const loteA = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.inventory_lots where household_id = $1 limit 1",
        [hogarA.householdId],
      ),
    ))!.id;
    await expect(
      h.como(USER_B, () => h.db.query("select public.adjust_lot($1, 1, null)", [loteA])),
    ).rejects.toThrow(/no autorizado|inexistente/i);
  });

  it("add_manual_lot rechaza un alimento privado de otro hogar", async () => {
    const privadoA = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `insert into public.ingredients (canonical_name, display_name, category_id, household_id)
         values ('reserva de fran', 'Reserva de Fran',
                 (select id from public.ingredient_categories where code = 'OTHER'), $1)
         returning id`,
        [hogarA.householdId],
      ),
    ))!.id;
    await expect(
      h.como(USER_B, () =>
        h.db.query(
          "select public.add_manual_lot($1, 'Robo', 100, 'G', $2, null, null, null)",
          [hogarB.householdId, privadoA],
        ),
      ),
    ).rejects.toThrow(/no pertenece/i);
  });
});
