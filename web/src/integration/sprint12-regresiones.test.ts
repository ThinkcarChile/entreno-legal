import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekStart } from "@/domain/nutrition/calendar";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Sprint 12 — regresiones de las cuatro fallas ALTAS y del eje ACTUAL_CONSUMED.
 *
 * Las cuatro correcciones de la auditoria (el tope por renglon, el ajuste sin
 * reversion, el oraculo en gramos y la fuga del dato clinico) viven hoy dentro
 * de 0036, y el eje de consumo real vive en 0038 — pero NINGUNA tenia test.
 * Una pared sin regresion es una pared que se cae sola en el proximo refactor,
 * y la suite se queda verde mientras se cae: es exactamente como los tres
 * defectos de la auditoria anterior llegaron a produccion con 748 en verde.
 */

const USER_A = "00000000-0000-0000-0000-0000000000e1";
const USER_B = "00000000-0000-0000-0000-0000000000e2";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let polloId: string;
let asignacionA: string;
let registroA: string;
let renglonA: string;
let loteA: string;

const SEMANA = weekStart("2026-09-28");
const LUNES = "2026-09-28";

/** Arma hogar + comida confirmada + stock, y devuelve la asignacion. */
async function prepararHogar(
  user: string,
  hogar: { householdId: string; memberId: string },
  etiquetasSinVerificar: string[],
): Promise<string> {
  const version = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;

  let asignacion = "";
  await h.como(user, async () => {
    const perfil = (await h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', 'firma-s12', '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 's12')`,
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
          nutrition: { energy_kcal: 500 },
          completeness: { energy_kcal: "COMPLETE" },
          reasons: [],
          unmet_constraints: [],
          unverifiable_constraints: etiquetasSinVerificar,
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
          ],
          substitutions: [],
        },
      ]),
    ]);

  });

  // Stock suficiente, por el libro mayor (jamas un update a mano al lote).
  // Va como admin porque la RLS de `inventory_lots` solo deja crearlos por los
  // RPC de recepcion; acá el lote es andamiaje, no lo que se está probando.
  await h.comoAdmin(async () => {
    const lote = (await h.fila<{ id: string }>(
      `insert into public.inventory_lots
         (household_id, ingredient_id, label, unit, quantity, weight_basis, status)
       values ($1, $2, 'Pechuga de pollo (sin piel)', 'G', 0, 'RAW', 'AVAILABLE')
       returning id`,
      [hogar.householdId, polloId],
    ))!.id;
    await h.db.query(
      `insert into public.inventory_movements (household_id, lot_id, reason, delta)
       values ($1, $2, 'PURCHASE', 1000)`,
      [hogar.householdId, lote],
    );
    if (user === USER_A) loteA = lote;
  });
  return asignacion;
}

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar S12 A", "Fran");
  // El vecino existe para probar el aislamiento entre hogares, nada mas.
  await crearHogar(h, USER_B, "Hogar S12 B", "Vecino");

  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;

  // El hogar A lleva una etiqueta CLINICA sin verificar: es el dato que la
  // cuarta falla filtraba por `plan_unverifiable_constraints`.
  asignacionA = await prepararHogar(USER_A, hogarA, ["ENERGY_MAX", "CLINICAL:phosphorus_mg"]);

  await h.como(USER_A, async () => {
    await h.db.query("select public.serve_meal_assignment($1)", [asignacionA]);
  });

  registroA = (await h.como(USER_A, () =>
    h.fila<{ id: string }>(
      "select id from public.meal_serving_records where assignment_id = $1",
      [asignacionA],
    ),
  ))!.id;
  renglonA = (await h.como(USER_A, () =>
    h.fila<{ id: string }>(
      "select id from public.meal_serving_record_items where record_id = $1",
      [registroA],
    ),
  ))!.id;
}, 120_000);

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------
describe("ALTO 1 — el renglon servido ACOTA, no solo autoriza", () => {
  it("un SEGUNDO CONSUMED sobre el mismo renglon no vuelve a descontar", async () => {
    // El renglon sirvio 200 y el libro mayor ya le saco 200. Un segundo
    // descuento cobraria dos veces la misma comida.
    await expect(
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, serving_record_item_id, covers_quantity)
           values ($1, $2, 'CONSUMED', -200, $3, -200)`,
          [hogarA.householdId, loteA, renglonA],
        ),
      ),
    ).rejects.toThrow(/cobrar dos veces/i);
  });

  it("y el espejo `deducted_quantity` ni siquiera se puede falsear", async () => {
    // El tope de arriba se mide contra el LIBRO MAYOR justamente para no
    // depender de esta columna. La defensa en profundidad es que la columna
    // TAMPOCO se puede torcer: bajarla a 0 —el paso previo para que un tope
    // que leyera el espejo quedara ciego— choca con el guardia de coherencia
    // antes de tocar disco. Servido = descontado + faltante, siempre.
    await expect(
      h.comoAdmin(() =>
        h.db.query(
          "update public.meal_serving_record_items set deducted_quantity = 0 where id = $1",
          [renglonA],
        ),
      ),
    ).rejects.toThrow(/no pueden divergir/i);

    const renglon = await h.como(USER_A, () =>
      h.fila<{ deducted_quantity: string }>(
        "select deducted_quantity from public.meal_serving_record_items where id = $1",
        [renglonA],
      ),
    );
    expect(Number(renglon!.deducted_quantity)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("ALTO 2 — sobre un renglon servido, ajustar ES revertir", () => {
  it("un ADJUSTMENT positivo SIN reverses_movement_id no repone nada", async () => {
    await expect(
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, serving_record_item_id, covers_quantity)
           values ($1, $2, 'ADJUSTMENT', 5000, $3, 5000)`,
          [hogarA.householdId, loteA, renglonA],
        ),
      ),
    ).rejects.toThrow(/movimiento que deshace|repone comida/i);
  });

  it("y el lote quedo intacto: no se fabrico ni un gramo", async () => {
    const lote = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [
        loteA,
      ]),
    );
    expect(Number(lote!.quantity)).toBe(800); // 1000 comprados - 200 servidos
  });
});

// ---------------------------------------------------------------------------
describe("ALTO 3 — devolver no es un oraculo en gramos", () => {
  it("sobre un renglon de OTRA casa contesta 'no autorizado', sin citar gramos", async () => {
    let mensaje = "";
    await h
      .como(USER_B, () =>
        h.db.query("select public.return_serving_to_inventory($1, $2, $3)", [
          renglonA,
          999999,
          "sondeo",
        ]),
      )
      .catch((e: unknown) => {
        mensaje = e instanceof Error ? e.message : String(e);
      });

    expect(mensaje).toMatch(/no autorizado/i);
    // Lo que NO puede aparecer: los gramos servidos ni los botados.
    expect(mensaje).not.toMatch(/\b200\b/);
    expect(mensaje).not.toMatch(/servid|botad/i);
  });

  it("un renglon INEXISTENTE contesta exactamente lo mismo", async () => {
    let mensaje = "";
    await h
      .como(USER_B, () =>
        h.db.query("select public.return_serving_to_inventory($1, $2, $3)", [
          "00000000-0000-0000-0000-00000000dead",
          999999,
          "sondeo",
        ]),
      )
      .catch((e: unknown) => {
        mensaje = e instanceof Error ? e.message : String(e);
      });
    expect(mensaje).toMatch(/no autorizado/i);
  });
});

// ---------------------------------------------------------------------------
describe("ALTO 4 — la etiqueta clinica no viaja por la tabla del hogar", () => {
  it("plan_unverifiable_constraints se queda SOLO con lo logistico", async () => {
    const reg = await h.como(USER_A, () =>
      h.fila<{ etiquetas: string }>(
        `select plan_unverifiable_constraints::text as etiquetas
         from public.meal_serving_records where id = $1`,
        [registroA],
      ),
    );
    expect(reg!.etiquetas).toContain("ENERGY_MAX");
    // El nombre del nutriente con techo clinico se lee solo: no puede estar.
    expect(reg!.etiquetas).not.toMatch(/CLINICAL|phosphorus/i);
  });

  it("y la mitad clinica se conserva, en la tabla con medical_access", async () => {
    const ctx = await h.comoAdmin(() =>
      h.fila<{ etiquetas: string | null }>(
        `select plan_clinical_constraints::text as etiquetas
         from public.meal_serving_clinical_context where record_id = $1`,
        [registroA],
      ),
    );
    // No se pierde el dato: cambia de dueno, que es distinto de borrarlo.
    expect(ctx!.etiquetas).toMatch(/phosphorus_mg/);
  });
});

// ---------------------------------------------------------------------------
describe("eje ACTUAL_CONSUMED (0038) — declarar consumo no mueve un gramo", () => {
  let log: string;

  it("log_intake escribe la declaracion y sus renglones", async () => {
    log = (await h.como(USER_A, () =>
      h.fila<{ log_intake: string }>("select public.log_intake($1)", [registroA]),
    ))!.log_intake;
    expect(log).toBeTruthy();

    const fila = await h.como(USER_A, () =>
      h.fila<{ status: string; affects_inventory: boolean }>(
        `select status::text as status, affects_inventory
         from public.consumption_logs where id = $1`,
        [log],
      ),
    );
    expect(fila!.status).toBe("ACTIVE");
    // OJO con leer mal esta columna: `affects_inventory` NO dice "este log
    // descuenta". Dice "esta comida SALIO de la despensa del hogar", y eso es
    // cierto porque detras hay un servido — que es el unico dueno del efecto
    // fisico. La prueba de que el log no mueve un gramo es la de mas abajo,
    // que mira el lote.
    expect(fila!.affects_inventory).toBe(true);

    const renglones = await h.como(USER_A, () =>
      h.filas("select 1 from public.intake_log_items where log_id = $1", [log]),
    );
    expect(renglones.length).toBeGreaterThan(0);
  });

  it("declarar consumo NO descuenta inventario", async () => {
    const lote = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [
        loteA,
      ]),
    );
    expect(Number(lote!.quantity)).toBe(800); // igual que antes de declarar
  });

  it("log_intake es idempotente: dos veces, una sola declaracion", async () => {
    const otra = (await h.como(USER_A, () =>
      h.fila<{ log_intake: string }>("select public.log_intake($1)", [registroA]),
    ))!.log_intake;
    expect(otra).toBe(log);
    const todas = await h.como(USER_A, () =>
      h.filas("select 1 from public.consumption_logs where serving_record_id = $1", [registroA]),
    );
    expect(todas).toHaveLength(1);
  });

  it("corregir SUPERA: la fila vieja queda a la vista, encadenada", async () => {
    const nuevo = (await h.como(USER_A, () =>
      h.fila<{ correct_intake_log: string }>(
        `select public.correct_intake_log($1, $2::jsonb, $3)`,
        [
          log,
          JSON.stringify([
            {
              label: "Pechuga de pollo (sin piel)",
              ingredient_id: polloId,
              extent: "EXACT",
              quantity: 120,
              quantity_is_declared: true,
              unit: "G",
              weight_basis: "RAW",
            },
          ]),
          "comio menos de lo que se le sirvio",
        ],
      ),
    ))!.correct_intake_log;

    const viejo = await h.como(USER_A, () =>
      h.fila<{ status: string }>(
        "select status::text as status from public.consumption_logs where id = $1",
        [log],
      ),
    );
    // Historia inmutable: no se reescribe, se supera.
    expect(viejo!.status).toBe("CORRECTED");

    const version = await h.como(USER_A, () =>
      h.fila<{ status: string; supersedes_log_id: string }>(
        `select status::text as status, supersedes_log_id
         from public.consumption_logs where id = $1`,
        [nuevo],
      ),
    );
    expect(version!.status).toBe("ACTIVE");
    expect(version!.supersedes_log_id).toBe(log);
  });

  it("anular exige un motivo y no se puede sobre una ya superada", async () => {
    await expect(
      h.como(USER_A, () => h.db.query("select public.void_intake_log($1, $2)", [log, "   "])),
    ).rejects.toThrow(/por que|por qu/i);
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.void_intake_log($1, $2)", [log, "me equivoque"]),
      ),
    ).rejects.toThrow(/superada|vigente/i);
  });

  it("el hogar vecino no ve ni toca la declaracion ajena", async () => {
    const ajeno = await h.como(USER_B, () =>
      h.filas("select 1 from public.consumption_logs where id = $1", [log]),
    );
    expect(ajeno).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("ALTO 5 — revertir no saca comida de la basura", () => {
  let merma: string;

  it("se declara una merma de lo servido: 80 g al basurero", async () => {
    await h.como(USER_A, () =>
      h.db.query("select public.discard_serving($1::uuid, 80, $2)", [
        renglonA,
        "se enfrio y nadie se lo comio",
      ]),
    );
    merma = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `select id from public.inventory_movements
         where serving_record_item_id = $1 and reason = 'DISCARDED_LEFTOVER'
           and covers_quantity < 0
         order by created_at desc, id desc limit 1`,
        [renglonA],
      ),
    ))!.id;
    expect(merma).toBeTruthy();

    // La merma NO vuelve a descontar: el lote ya pago al servir.
    const lote = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [
        loteA,
      ]),
    );
    expect(Number(lote!.quantity)).toBe(800);
  });

  it("un ADJUSTMENT que revierte esa merma NO repone stock", async () => {
    // El ataque pasaba entero: los topes que ya existian no lo veian. El (7)
    // mide contra la cobertura del movimiento original (80 disponibles) y el
    // (8) hace 0 devueltos + 80 botados + 80 = 160, que no supera los 200 que
    // el renglon le saco a la despensa. El lote subia a 880 mientras el espejo
    // seguia diciendo que esos mismos 80 g estaban botados.
    await expect(
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, serving_record_item_id,
              covers_quantity, reverses_movement_id)
           values ($1, $2, 'ADJUSTMENT', 80, $3, 80, $4)`,
          [hogarA.householdId, loteA, renglonA, merma],
        ),
      ),
    ).rejects.toThrow(/basura/i);

    const lote = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [
        loteA,
      ]),
    );
    expect(Number(lote!.quantity)).toBe(800);
  });

  it("pero deshacer un descarte MAL MARCADO sigue siendo un camino legitimo", async () => {
    // `undo_discard_serving` no escribe `reverses_movement_id` y no mueve un
    // gramo: le devuelve al renglon el derecho a decidir, nada mas. Tapar el
    // agujero no podia cerrarle la puerta a quien se equivoco al marcar.
    await h.como(USER_A, () =>
      h.db.query("select public.undo_discard_serving($1::uuid, 80, $2)", [
        renglonA,
        "estaba mal marcado",
      ]),
    );

    const renglon = await h.como(USER_A, () =>
      h.fila<{ discarded_quantity: string }>(
        "select discarded_quantity from public.meal_serving_record_items where id = $1",
        [renglonA],
      ),
    );
    expect(Number(renglon!.discarded_quantity)).toBe(0);

    const lote = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [
        loteA,
      ]),
    );
    expect(Number(lote!.quantity)).toBe(800); // ni un gramo se movio
  });

  it("y revertir un CONSUMED de verdad —el unico caso legitimo— sigue funcionando", async () => {
    await h.como(USER_A, () =>
      h.db.query("select public.return_serving_to_inventory($1::uuid, 50, $2)", [
        renglonA,
        "se sirvio de mas",
      ]),
    );
    const lote = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [
        loteA,
      ]),
    );
    expect(Number(lote!.quantity)).toBe(850);
  });

  it("revertir la REVERSION tampoco: se re-descontaria por la puerta de atras", async () => {
    // Un ADJUSTMENT con `reverses_movement_id` es una devolucion. Revertirla
    // seria volver a descontar sin pasar por el tope (4b), que solo cuenta
    // CONSUMED. Corregir de nuevo a la baja se hace con un CONSUMED nuevo.
    const devolucion = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `select id from public.inventory_movements
         where serving_record_item_id = $1 and reason = 'ADJUSTMENT'
           and reverses_movement_id is not null
         order by created_at desc, id desc limit 1`,
        [renglonA],
      ),
    ))!.id;

    await expect(
      h.comoAdmin(() =>
        h.db.query(
          `insert into public.inventory_movements
             (household_id, lot_id, reason, delta, serving_record_item_id,
              covers_quantity, reverses_movement_id)
           values ($1, $2, 'ADJUSTMENT', -50, $3, -50, $4)`,
          [hogarA.householdId, loteA, renglonA, devolucion],
        ),
      ),
    ).rejects.toThrow(/solo se revierte un descuento por comer/i);

    const lote = await h.como(USER_A, () =>
      h.fila<{ quantity: string }>("select quantity from public.inventory_lots where id = $1", [
        loteA,
      ]),
    );
    expect(Number(lote!.quantity)).toBe(850);
  });
});
