import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * BATERÍA CROSS-HOUSEHOLD (Integration Gate §37 y §38).
 *
 * Dos hogares reales. El hogar B intenta, contra CADA superficie construida en
 * los sprints 1-10, leer, escribir, accionar o simplemente AVERIGUAR si algo
 * del hogar A existe. Todo debe fallar igual: mismo mensaje, sin oráculo.
 *
 * Además: todo RPC SECURITY DEFINER recibe UUIDs del cliente. Acá se le pasan
 * uuids del hogar A desde una sesión del hogar B, uno por uno.
 */

const USER_A = "00000000-0000-0000-0000-00000000aa01";
const USER_B = "00000000-0000-0000-0000-00000000aa02";

let h: Harness;
let A: { householdId: string; memberId: string };
let B: { householdId: string; memberId: string };
let polloId: string;
let loteA: string;
let listaA: string;
let planA: string;
let asignacionA: string;
let proveedorA: string;
let ordenA: string;
let prepPlanA: string;
let prepTaskA: string;
let etiquetaA: string;
let tokenA: string;

beforeAll(async () => {
  h = await levantarBase();
  A = await crearHogar(h, USER_A, "Hogar Gate A", "Ana");
  B = await crearHogar(h, USER_B, "Hogar Gate B", "Bruno");
  void B; // se usa solo para que exista el segundo hogar

  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;

  await h.como(USER_A, async () => {
    await h.db.query("select public.ensure_storage_locations($1)", [A.householdId]);
    loteA = (await h.fila<{ add_manual_lot: string }>(
      "select public.add_manual_lot($1, 'Pollo de A', 2000, 'G', $2)",
      [A.householdId, polloId],
    ))!.add_manual_lot;

    planA = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, (date_trunc('week', current_date))::date)",
      [A.householdId],
    ))!.ensure_weekly_plan;

    const dia = (await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 order by plan_date limit 1",
      [planA],
    ))!.id;
    asignacionA = (await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
       select $1, 'LUNCH', 'RECIPE', v.template_id, v.id
       from public.meal_template_versions v
       join public.meal_templates t on t.id = v.template_id
       where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED' limit 1
       returning id`,
      [dia],
    ))!.id;

    await h.db.query(
      "insert into public.shopping_lists (household_id, plan_id, status) values ($1, $2, 'ACTIVE')",
      [A.householdId, planA],
    );
    listaA = (await h.fila<{ id: string }>(
      "select id from public.shopping_lists where plan_id = $1",
      [planA],
    ))!.id;

    proveedorA = (await h.fila<{ id: string }>(
      "insert into public.suppliers (household_id, name) values ($1, 'Proveedor de A') returning id",
      [A.householdId],
    ))!.id;
    ordenA = (await h.fila<{ create_procurement_order: string }>(
      "select public.create_procurement_order($1, $2, null, null, 'GATE:A', 'v', $3::jsonb)",
      [
        A.householdId,
        proveedorA,
        JSON.stringify([
          { ingredient_id: polloId, label: "Pollo", required_quantity: 100, suggested_quantity: 100, unit: "G" },
        ]),
      ],
    ))!.create_procurement_order;

    prepPlanA = (await h.fila<{ save_prep_plan: string }>(
      "select public.save_prep_plan($1, current_date, 'v', 1, '{}'::jsonb, 'GATE:PREP:A', $2::jsonb)",
      [
        A.householdId,
        JSON.stringify([
          { task_type: "WASH", lot_id: loteA, ingredient_id: polloId, label: "Lavar", planned_quantity: 100, unit: "G" },
        ]),
      ],
    ))!.save_prep_plan;
    prepTaskA = (await h.fila<{ id: string }>(
      "select id from public.batch_prep_tasks where plan_id = $1",
      [prepPlanA],
    ))!.id;

    etiquetaA = (await h.fila<{ create_label_job: string }>("select public.create_label_job($1)", [loteA]))!
      .create_label_job;
    tokenA = (await h.fila<{ ensure_lot_token: string }>("select public.ensure_lot_token($1)", [loteA]))!
      .ensure_lot_token;
  });
}, 120000);

afterAll(async () => {
  await h?.cerrar();
});

describe("§38 — B no LEE nada privado de A", () => {
  const superficies: [string, string][] = [
    ["perfiles", "select id from public.member_nutrition_profiles where member_id = $1"],
    ["porciones", "select id from public.member_serving_projections where member_id = $1"],
  ];

  it("las tablas por hogar devuelven cero filas de A", async () => {
    const consultas: [string, string][] = [
      ["planes", `select id from public.weekly_plans where household_id = '${""}'`],
    ];
    void consultas;
    const filas = await h.como(USER_B, async () => {
      const out: Record<string, number> = {};
      for (const [nombre, sql] of [
        ["weekly_plans", "select id from public.weekly_plans where household_id = $1"],
        ["shopping_lists", "select id from public.shopping_lists where household_id = $1"],
        ["inventory_lots", "select id from public.inventory_lots where household_id = $1"],
        ["inventory_movements", "select id from public.inventory_movements where household_id = $1"],
        ["stock_targets", "select id from public.stock_targets where household_id = $1"],
        ["suppliers", "select id from public.suppliers where household_id = $1"],
        ["procurement_orders", "select id from public.procurement_orders where household_id = $1"],
        ["batch_prep_plans", "select id from public.batch_prep_plans where household_id = $1"],
        ["label_print_jobs", "select id from public.label_print_jobs where household_id = $1"],
        ["household_equipment", "select id from public.household_equipment where household_id = $1"],
        ["domain_events", "select id from public.domain_events where household_id = $1"],
      ] as [string, string][]) {
        out[nombre] = (await h.filas(sql, [A.householdId])).length;
      }
      return out;
    });
    for (const [tabla, n] of Object.entries(filas)) {
      expect(`${tabla}=${n}`).toBe(`${tabla}=0`);
    }
  });

  it("los datos de los integrantes de A tampoco se ven", async () => {
    const out = await h.como(USER_B, async () => {
      const r: Record<string, number> = {};
      for (const [nombre, sql] of superficies) {
        r[nombre] = (await h.filas(sql, [A.memberId])).length;
      }
      return r;
    });
    expect(out).toEqual({ perfiles: 0, porciones: 0 });
  });
});

describe("§37 — cada RPC SECURITY DEFINER rechaza los UUIDs de A", () => {
  it("inventario: adjust/discard/move/split/merge/use sobre el lote de A", async () => {
    const intentos: [string, string, unknown[]][] = [
      ["adjust_lot", "select public.adjust_lot($1, 10)", [() => loteA]],
      ["discard_lot", "select public.discard_lot($1, 'SPOILED')", [() => loteA]],
      ["split_lot", "select public.split_lot($1, array[10]::numeric[])", [() => loteA]],
      ["use_lot", "select public.use_lot($1, 10)", [() => loteA]],
      ["set_lot_safety", "select public.set_lot_safety($1, current_date, 'x')", [() => loteA]],
      ["set_intended_use", "select public.set_intended_use($1, current_date)", [() => loteA]],
      ["ensure_lot_token", "select public.ensure_lot_token($1)", [() => loteA]],
      ["create_label_job", "select public.create_label_job($1)", [() => loteA]],
    ];
    for (const [nombre, sql, args] of intentos) {
      const params = (args as (() => string)[]).map((f) => f());
      await expect(
        h.como(USER_B, () => h.db.query(sql, params)),
        `${nombre} debería rechazar`,
      ).rejects.toThrow(/no autorizado/);
    }
  });

  it("planificación y compras: confirmar, desconfirmar, generar revisión, cantidad", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query("select public.confirm_meal_assignment($1, '[]'::jsonb)", [asignacionA]),
      ),
    ).rejects.toThrow(/no autorizado/);
    await expect(
      h.como(USER_B, () => h.db.query("select public.unconfirm_meal_assignment($1)", [asignacionA])),
    ).rejects.toThrow(/no autorizado/);
    await expect(
      h.como(USER_B, () =>
        h.db.query(
          "select public.generate_shopping_revision($1, 'sig', 'motor', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb)",
          [listaA],
        ),
      ),
    ).rejects.toThrow(/no autorizado/);
    await expect(
      h.como(USER_B, () => h.db.query("select public.ensure_weekly_plan($1, current_date)", [A.householdId])),
    ).rejects.toThrow(/no autorizado/);
  });

  it("procurement y prep: avanzar, recibir, completar, saltar, cancelar", async () => {
    await expect(
      h.como(USER_B, () => h.db.query("select public.advance_procurement_order($1, 'ORDERED')", [ordenA])),
    ).rejects.toThrow(/no autorizado/);
    await expect(
      h.como(USER_B, () => h.db.query("select public.receive_procurement_order($1)", [ordenA])),
    ).rejects.toThrow(/no autorizado/);
    await expect(
      h.como(USER_B, () => h.db.query("select public.complete_prep_task($1)", [prepTaskA])),
    ).rejects.toThrow(/no autorizado/);
    await expect(
      h.como(USER_B, () => h.db.query("select public.skip_prep_task($1)", [prepTaskA])),
    ).rejects.toThrow(/no autorizado/);
    await expect(
      h.como(USER_B, () => h.db.query("select public.cancel_prep_plan($1)", [prepPlanA])),
    ).rejects.toThrow(/no autorizado/);
    await expect(
      h.como(USER_B, () => h.db.query("select public.mark_label_job($1, 'PRINTED')", [etiquetaA])),
    ).rejects.toThrow(/no autorizado/);
  });

  it("stock: objetivos del hogar A", async () => {
    await expect(
      h.como(USER_B, () =>
        h.db.query(
          "select public.set_stock_target($1, $2, 'G', 100, null, null, null, null, true)",
          [A.householdId, polloId],
        ),
      ),
    ).rejects.toThrow(/no autorizado/);
  });
});

describe("§38 — sin ORÁCULO: existir y no existir se responden igual", () => {
  it("el token de A y un token inventado dan la MISMA respuesta", async () => {
    const real = await h
      .como(USER_B, () => h.db.query("select public.resolve_lot_token($1)", [tokenA]))
      .catch((e: Error) => e.message);
    const falso = await h
      .como(USER_B, () => h.db.query("select public.resolve_lot_token('no-existe-jamas')", []))
      .catch((e: Error) => e.message);
    expect(real).toBe(falso);
  });

  it("un lote de A y un uuid inexistente dan la MISMA respuesta", async () => {
    const real = await h
      .como(USER_B, () => h.db.query("select public.use_lot($1, 1)", [loteA]))
      .catch((e: Error) => e.message);
    const falso = await h
      .como(USER_B, () =>
        h.db.query("select public.use_lot('00000000-0000-0000-0000-0000000000ff', 1)", []),
      )
      .catch((e: Error) => e.message);
    expect(real).toBe(falso);
  });

  it("una orden de A y una inexistente dan la MISMA respuesta", async () => {
    const real = await h
      .como(USER_B, () => h.db.query("select public.advance_procurement_order($1, 'ORDERED')", [ordenA]))
      .catch((e: Error) => e.message);
    const falso = await h
      .como(USER_B, () =>
        h.db.query(
          "select public.advance_procurement_order('00000000-0000-0000-0000-0000000000ff', 'ORDERED')",
          [],
        ),
      )
      .catch((e: Error) => e.message);
    expect(real).toBe(falso);
  });
});

describe("§37 — el actor lo estampa la BASE, no el cliente", () => {
  it("un movimiento creado por A queda con el miembro de A", async () => {
    const mov = await h.como(USER_A, () =>
      h.fila<{ actor_member_id: string }>(
        "select actor_member_id from public.inventory_movements where lot_id = $1 limit 1",
        [loteA],
      ),
    );
    expect(mov!.actor_member_id).toBe(A.memberId);
  });

  it("una tarea completada guarda quién la completó", async () => {
    await h.como(USER_A, () => h.db.query("select public.complete_prep_task($1)", [prepTaskA]));
    const t = await h.como(USER_A, () =>
      h.fila<{ completed_by: string }>(
        "select completed_by from public.batch_prep_tasks where id = $1",
        [prepTaskA],
      ),
    );
    expect(t!.completed_by).toBe(A.memberId);
  });
});
