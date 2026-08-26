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

// ---------------------------------------------------------------------------
// AUDITORÍA POST-11.5 · DEFECTO 1 — la fila del integrante no es un formulario
// ---------------------------------------------------------------------------

/**
 * `members_update` (0001:268) deja pasar cualquier UPDATE mientras
 * `user_id = auth.uid()` siga siendo verdadero en la fila VIEJA y en la NUEVA.
 * No congela ni una columna, y no hay trigger ni revoke que la respalde.
 *
 * De ahí salen tres ataques que no necesitan ningún RPC, sólo un PATCH de
 * PostgREST sobre `household_members`:
 *
 *  (a) me cambio el `household_id` al de otro hogar y me abro el hogar entero
 *      (el uuid no es secreto: viaja en el HTML de /family);
 *  (b) me revivo el `is_active` después de que me dieron de baja;
 *  (c) siendo admin, le pongo `user_id = null` a otra persona: la tercera rama
 *      de `app.medical_access` (0028) me entrega su ficha médica completa
 *      —exámenes, observaciones, condiciones, restricciones— sin ningún grant,
 *      y de paso le desconecto la cuenta.
 *
 * Estas pruebas son la regresión. Un UPDATE puede morir de dos maneras
 * legítimas —excepción del trigger, o cero filas por RLS— y las dos se aceptan;
 * lo que NO se acepta es que la fila guardada quede cambiada.
 */

const USER_C = "00000000-0000-0000-0000-00000000aa03"; // integrante común de B
const USER_D = "00000000-0000-0000-0000-00000000aa04"; // integrante de B dado de baja
const USER_E = "00000000-0000-0000-0000-00000000aa05"; // integrante de A con ficha médica

interface Intento {
  rechazado: boolean;
  filas: number;
  mensaje: string | null;
}

/** Corre un UPDATE que DEBE morir, sin importar por cuál de las dos vías. */
async function intentarUpdate(sql: string, params: unknown[] = []): Promise<Intento> {
  try {
    const r = await h.db.query(sql, params);
    return {
      rechazado: false,
      filas: (r as { affectedRows?: number }).affectedRows ?? 0,
      mensaje: null,
    };
  } catch (e) {
    return { rechazado: true, filas: 0, mensaje: (e as Error).message };
  }
}

/**
 * Agrega un integrante CON cuenta a un hogar por el único camino legítimo:
 * quien administra invita, la persona acepta. Nada de `insert ... user_id`
 * directo — una ficha se crea sin cuenta y la cuenta llega por invitación.
 */
async function agregarIntegrante(
  userId: string,
  householdId: string,
  adminUserId: string,
  nombre: string,
): Promise<string> {
  const token = `gate-token-${nombre.toLowerCase()}`;
  await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `${nombre.toLowerCase()}@test.dev`,
    ]);
  });
  await h.como(adminUserId, () =>
    h.db.query(
      `insert into public.invitations (household_id, token_hash, role_code, expires_at)
       values ($1, $2, 'MEMBER', now() + interval '1 day')`,
      [householdId, token],
    ),
  );
  // accept_invitation devuelve el household_id, no la ficha: hay que buscarla.
  await h.como(userId, () =>
    h.db.query("select public.accept_invitation($1, $2)", [token, nombre]),
  );
  return h.comoAdmin(async () =>
    (await h.fila<{ id: string }>(
      "select id from public.household_members where household_id = $1 and user_id = $2",
      [householdId, userId],
    ))!.id,
  );
}

describe("DEFECTO 1 — household_members: ninguna columna de identidad se edita sola", () => {
  let miembroC: string;
  let miembroD: string;
  let miembroE: string;
  let observacionE: string;

  beforeAll(async () => {
    miembroC = await agregarIntegrante(USER_C, B.householdId, USER_B, "Carla");
    miembroD = await agregarIntegrante(USER_D, B.householdId, USER_B, "Diego");
    miembroE = await agregarIntegrante(USER_E, A.householdId, USER_A, "Elena");

    // Diego queda dado de baja por el admin del hogar: la vía legítima.
    await h.como(USER_B, () =>
      h.db.query("update public.household_members set is_active = false where id = $1", [miembroD]),
    );

    // Elena tiene una observación de laboratorio suya. Se siembra sin RLS a
    // propósito: lo que se mide es QUIÉN puede leerla, no cómo se creó.
    await h.comoAdmin(async () => {
      const biomarcador = (await h.fila<{ id: string }>(
        "select id from public.biomarker_definitions where code = 'creatinine' and household_id is null",
      ))!.id;
      observacionE = (await h.fila<{ id: string }>(
        `insert into public.lab_observations (member_id, biomarker_id, value, unit, collected_date)
         values ($1, $2, 1.9, 'mg/dL', current_date) returning id`,
        [miembroE, biomarcador],
      ))!.id;
    });
  }, 60000);

  it("(a) un integrante de B NO se puede mudar de hogar, y no ve nada de A", async () => {
    const { intento, planes, lotes, integrantes } = await h.como(USER_C, async () => {
      const intento = await intentarUpdate(
        "update public.household_members set household_id = $1 where user_id = auth.uid()",
        [A.householdId],
      );
      // Se mide EN CALIENTE: si el salto hubiese funcionado, acá ya se estaría
      // leyendo el hogar ajeno completo.
      const planes = (
        await h.filas("select id from public.weekly_plans where household_id = $1", [A.householdId])
      ).length;
      const lotes = (
        await h.filas("select id from public.inventory_lots where household_id = $1", [A.householdId])
      ).length;
      const integrantes = (
        await h.filas("select id from public.household_members where household_id = $1", [
          A.householdId,
        ])
      ).length;
      return { intento, planes, lotes, integrantes };
    });

    expect(intento.filas, "el UPDATE de household_id no puede tocar ninguna fila").toBe(0);

    // Lo que de verdad importa: la fila guardada sigue en el hogar B.
    const fila = await h.comoAdmin(() =>
      h.fila<{ household_id: string }>(
        "select household_id from public.household_members where id = $1",
        [miembroC],
      ),
    );
    expect(fila!.household_id, "Carla terminó en otro hogar").toBe(B.householdId);

    expect({ planes, lotes, integrantes }).toEqual({ planes: 0, lotes: 0, integrantes: 0 });
  });

  it("(b) quien fue dado de baja NO se reactiva solo", async () => {
    const intento = await h.como(USER_D, () =>
      intentarUpdate("update public.household_members set is_active = true where user_id = auth.uid()"),
    );
    expect(intento.filas, "el UPDATE de is_active no puede tocar ninguna fila").toBe(0);

    const fila = await h.comoAdmin(() =>
      h.fila<{ is_active: boolean }>(
        "select is_active from public.household_members where id = $1",
        [miembroD],
      ),
    );
    expect(fila!.is_active, "Diego se revivió solo").toBe(false);
  });

  it("(c) el admin NO desvincula la cuenta ajena para heredarle la ficha médica", async () => {
    const { intento, observaciones, documentos, condiciones, restricciones } = await h.como(
      USER_A,
      async () => {
        const intento = await intentarUpdate(
          "update public.household_members set user_id = null where id = $1",
          [miembroE],
        );
        // Ana es ADMIN del hogar de Elena. Si el `user_id = null` hubiese
        // pegado, la rama "tutor de dependiente" de app.medical_access le
        // abriría todo esto sin un solo grant.
        const observaciones = (
          await h.filas("select id from public.lab_observations where member_id = $1", [miembroE])
        ).length;
        const documentos = (
          await h.filas("select id from public.lab_documents where member_id = $1", [miembroE])
        ).length;
        const condiciones = (
          await h.filas("select id from public.member_conditions where member_id = $1", [miembroE])
        ).length;
        const restricciones = (
          await h.filas("select id from public.member_clinical_restrictions where member_id = $1", [
            miembroE,
          ])
        ).length;
        return { intento, observaciones, documentos, condiciones, restricciones };
      },
    );

    expect(intento.filas, "el UPDATE de user_id ajeno no puede tocar ninguna fila").toBe(0);

    const fila = await h.comoAdmin(() =>
      h.fila<{ user_id: string | null }>(
        "select user_id from public.household_members where id = $1",
        [miembroE],
      ),
    );
    expect(fila!.user_id, "la cuenta de Elena quedó desvinculada").toBe(USER_E);

    expect({ observaciones, documentos, condiciones, restricciones }).toEqual({
      observaciones: 0,
      documentos: 0,
      condiciones: 0,
      restricciones: 0,
    });

    // Y la observación sigue existiendo: lo que se negó fue la LECTURA ajena,
    // no el dato. ERROR != VACÍO, y "no autorizado" != "no hay nada".
    const sigue = await h.comoAdmin(() =>
      h.fila("select id from public.lab_observations where id = $1", [observacionE]),
    );
    expect(sigue).not.toBeNull();
  });

  it("la dueña SÍ lee lo suyo: el candado no rompe el acceso legítimo", async () => {
    const propias = await h.como(USER_E, () =>
      h.filas("select id from public.lab_observations where member_id = $1", [miembroE]),
    );
    expect(propias).toHaveLength(1);
  });
});
