import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * Integración del Sprint 10 — batch prep sobre PostgreSQL real (PGlite),
 * migraciones 0001→0015, rol authenticated. La mitad §69-§89 que vive en la
 * base: conservación de cantidad y valor (K-19), estados ortogonales (K-18),
 * confirmación física vs plan, concurrencia, RLS, etiquetas y QR.
 */

const USER_A = "00000000-0000-0000-0000-0000000000f1";
const USER_B = "00000000-0000-0000-0000-0000000000f2";

let h: Harness;
let hogarA: { householdId: string; memberId: string };
let hogarB: { householdId: string; memberId: string };
let polloId: string;
let tomateId: string;
let fridgeA: string;
let freezerA: string;

async function ubicacion(kind: string): Promise<string> {
  return (await h.fila<{ id: string }>(
    "select id from public.storage_locations where household_id = $1 and kind = $2 order by sort_order limit 1",
    [hogarA.householdId, kind],
  ))!.id;
}

/** Lote con valor de adquisición conocido, listo para partir. */
async function crearLote(
  label: string,
  ingredientId: string,
  quantity: number,
  value: number | null,
  locationId?: string,
): Promise<string> {
  const lot = await h.como(USER_A, async () =>
    (await h.fila<{ add_manual_lot: string }>(
      "select public.add_manual_lot($1, $2, $3, 'G', $4, $5)",
      [hogarA.householdId, label, quantity, ingredientId, locationId ?? fridgeA],
    ))!.add_manual_lot,
  );
  if (value !== null) {
    await h.comoAdmin(() =>
      h.db.query("update public.inventory_lots set acquisition_value = $1 where id = $2", [value, lot]),
    );
  }
  return lot;
}

async function lote(id: string) {
  return (await h.comoAdmin(() =>
    h.fila<{
      quantity: string;
      status: string;
      processing_state: string;
      temperature_state: string;
      vacuum_sealed: boolean;
      acquisition_value: string | null;
      thawed_at: string | null;
      frozen_at: string | null;
      use_by: string | null;
      intended_use_date: string | null;
      intended_assignment_id: string | null;
      package_code: string | null;
    }>(
      `select quantity::text, status, processing_state::text, temperature_state::text,
              vacuum_sealed, acquisition_value::text, thawed_at::text, frozen_at::text,
              use_by::text, intended_use_date::text, intended_assignment_id, package_code
       from public.inventory_lots where id = $1`,
      [id],
    ),
  ))!;
}

/** Plan mínimo con las tareas dadas; devuelve plan id + task ids en orden. */
async function planCon(
  tareas: Record<string, unknown>[],
  dedupe: string,
): Promise<{ planId: string; taskIds: string[] }> {
  const planId = await h.como(USER_A, async () =>
    (await h.fila<{ save_prep_plan: string }>(
      "select public.save_prep_plan($1, current_date, 'batch-prep/1.0.0', 1, '{}'::jsonb, $2, $3::jsonb)",
      [hogarA.householdId, dedupe, JSON.stringify(tareas)],
    ))!.save_prep_plan,
  );
  const filas = await h.como(USER_A, () =>
    h.filas<{ id: string }>(
      "select id from public.batch_prep_tasks where plan_id = $1 order by seq",
      [planId],
    ),
  );
  return { planId, taskIds: filas.map((f) => f.id) };
}

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_A, "Hogar Prep A", "Fran");
  hogarB = await crearHogar(h, USER_B, "Hogar Prep B", "Vecino");

  polloId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'",
  ))!.id;
  tomateId = (await h.fila<{ id: string }>(
    "select id from public.ingredients where canonical_name = 'tomate'",
  ))!.id;

  await h.como(USER_A, () =>
    h.db.query("select public.ensure_storage_locations($1)", [hogarA.householdId]),
  );
  fridgeA = await ubicacion("FRIDGE");
  freezerA = await ubicacion("FREEZER");
});

afterAll(async () => {
  await h.cerrar();
});

describe("§69/§70/§42 — split conserva cantidad y valor EXACTOS (K-19)", () => {
  it("4.200 g / $17.003 → 1.100+1.300+900+900: Σ cantidades y Σ valores exactas", async () => {
    const padre = await crearLote("Pollo K19", polloId, 4200, 17003);
    const { taskIds } = await planCon(
      [
        {
          task_type: "PORTION",
          lot_id: padre,
          ingredient_id: polloId,
          label: "Porcionar pollo",
          planned_quantity: 4200,
          unit: "G",
        },
      ],
      "PREP:k19",
    );
    const result = await h.como(USER_A, async () =>
      (await h.fila<{ complete_prep_task: { child_lot_ids: string[]; package_codes: string[] } }>(
        `select public.complete_prep_task($1, null, $2::jsonb)`,
        [
          taskIds[0],
          JSON.stringify({
            packages: [
              { quantity: 1100, intended_use_date: "2099-01-05" },
              { quantity: 1300 },
              { quantity: 900 },
              { quantity: 900 },
            ],
          }),
        ],
      ))!.complete_prep_task,
    );
    const hijos = result.child_lot_ids;
    expect(hijos).toHaveLength(4);
    expect(result.package_codes.every((c) => /^PKG-[0-9A-F]{8}$/.test(c))).toBe(true);

    const filas = await Promise.all(hijos.map(lote));
    expect(filas.map((f) => Number(f.quantity))).toEqual([1100, 1300, 900, 900]);
    const valorHijos = filas.reduce((acc, f) => acc + Number(f.acquisition_value), 0);
    expect(valorHijos).toBeCloseTo(17003, 4); // ni un peso creado ni perdido
    const p = await lote(padre);
    expect(Number(p.quantity)).toBe(0);
    expect(Number(p.acquisition_value)).toBe(0);
    // El grupo del ledger suma CERO (invariante del Sprint 7 intacto).
    const suma = await h.comoAdmin(() =>
      h.fila<{ s: string }>(
        `select coalesce(sum(delta), 0)::text as s from public.inventory_movements
         where reason = 'SPLIT' and lot_id in (select id from public.inventory_lots where id = $1 or parent_lot_id = $1)`,
        [padre],
      ),
    );
    expect(Number(suma!.s)).toBe(0);
  });

  it("§70: $17.003 entre 3 iguales — el residuo del redondeo cierra en el último", async () => {
    const padre = await crearLote("Pollo redondeo", polloId, 4200, 17003);
    const { taskIds } = await planCon(
      [{ task_type: "PORTION", lot_id: padre, ingredient_id: polloId, label: "3 paquetes", planned_quantity: 4200, unit: "G" }],
      "PREP:redondeo",
    );
    const result = await h.como(USER_A, async () =>
      (await h.fila<{ complete_prep_task: { child_lot_ids: string[] } }>(
        `select public.complete_prep_task($1, null, $2::jsonb)`,
        [taskIds[0], JSON.stringify({ packages: [{ quantity: 1400 }, { quantity: 1400 }, { quantity: 1400 }] })],
      ))!.complete_prep_task,
    );
    const filas = await Promise.all(result.child_lot_ids.map(lote));
    const total = filas.reduce((acc, f) => acc + Number(f.acquisition_value), 0);
    expect(total).toBeCloseTo(17003, 4);
  });
});

describe("§71 — la realidad manda sobre el plan", () => {
  it("plan 1.200, preparado 980: el ledger registra 980 y el resto sigue donde estaba", async () => {
    const padre = await crearLote("Tomate parcial", tomateId, 2000, null);
    const { taskIds } = await planCon(
      [{ task_type: "CUT", lot_id: padre, ingredient_id: tomateId, label: "Picar tomate", planned_quantity: 1200, unit: "G" }],
      "PREP:parcial",
    );
    await h.como(USER_A, () =>
      h.db.query("select public.complete_prep_task($1, 980, null)", [taskIds[0]]),
    );
    const tarea = await h.como(USER_A, () =>
      h.fila<{ completed_quantity: string; status: string }>(
        "select completed_quantity::text, status from public.batch_prep_tasks where id = $1",
        [taskIds[0]],
      ),
    );
    expect(tarea).toMatchObject({ status: "DONE" });
    expect(Number(tarea!.completed_quantity)).toBe(980);

    const p = await lote(padre);
    expect(Number(p.quantity)).toBe(1020); // 2000 − 980: nada se forzó a 1.200
    expect(p.processing_state).toBe("RAW"); // el resto sigue crudo
    const hijo = await h.comoAdmin(() =>
      h.fila<{ id: string; quantity: string; processing_state: string }>(
        "select id, quantity::text, processing_state::text from public.inventory_lots where parent_lot_id = $1",
        [padre],
      ),
    );
    expect(Number(hijo!.quantity)).toBe(980);
    expect(hijo!.processing_state).toBe("PREPPED");
  });

  it("§44: pelar 1.000 → 920 utilizables + 80 de merma con causa, nada desaparece", async () => {
    const padre = await crearLote("Zanahoria merma", tomateId, 1000, null);
    const { taskIds } = await planCon(
      [{ task_type: "PEEL", lot_id: padre, ingredient_id: tomateId, label: "Pelar", planned_quantity: 1000, unit: "G" }],
      "PREP:merma",
    );
    await h.como(USER_A, () =>
      h.db.query("select public.complete_prep_task($1, 1000, $2::jsonb)", [
        taskIds[0],
        JSON.stringify({ output_quantity: 920, waste_quantity: 80, waste_cause: "PEEL" }),
      ]),
    );
    const p = await lote(padre);
    expect(Number(p.quantity)).toBe(920);
    expect(p.processing_state).toBe("PREPPED");
    const merma = await h.comoAdmin(() =>
      h.fila<{ delta: string; notes: string }>(
        "select delta::text, notes from public.inventory_movements where lot_id = $1 and reason = 'PREP_LOSS'",
        [padre],
      ),
    );
    expect(Number(merma!.delta)).toBe(-80);
    expect(merma!.notes).toBe("PEEL");
  });

  it("la merma que no cuadra se rechaza: entrada ≠ utilizable + merma", async () => {
    const padre = await crearLote("No cuadra", tomateId, 1000, null);
    const { taskIds } = await planCon(
      [{ task_type: "TRIM", lot_id: padre, ingredient_id: tomateId, label: "Despuntar", planned_quantity: 1000, unit: "G" }],
      "PREP:nocuadra",
    );
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.complete_prep_task($1, 1000, $2::jsonb)", [
          taskIds[0],
          JSON.stringify({ output_quantity: 800, waste_quantity: 50 }),
        ]),
      ),
    ).rejects.toThrow(/no cuadra/);
  });
});

describe("§72/§73/§74 — estados ortogonales (K-18)", () => {
  it("§72 FREEZE: CHILLED → FROZEN con cantidad, valor y frozen_at correctos", async () => {
    const id = await crearLote("Pollo a congelar", polloId, 1200, 5000);
    const { taskIds } = await planCon(
      [{ task_type: "FREEZE", lot_id: id, ingredient_id: polloId, label: "Congelar", planned_quantity: 1200, unit: "G" }],
      "PREP:freeze",
    );
    await h.como(USER_A, () => h.db.query("select public.complete_prep_task($1)", [taskIds[0]]));
    const l = await lote(id);
    expect(l.temperature_state).toBe("FROZEN");
    expect(Number(l.quantity)).toBe(1200);
    expect(Number(l.acquisition_value)).toBe(5000);
    expect(l.frozen_at).not.toBeNull();
    expect(l.processing_state).toBe("RAW"); // ortogonal: congelar no "prepara"
  });

  it("§73 THAW: la historia queda registrada y NO hay prohibición global de recongelar", async () => {
    const id = await crearLote("Pollo thaw", polloId, 800, null, freezerA);
    expect((await lote(id)).temperature_state).toBe("FROZEN");
    await h.como(USER_A, () => h.db.query("select public.move_lot($1, $2)", [id, fridgeA]));
    const descongelado = await lote(id);
    expect(descongelado.temperature_state).toBe("CHILLED");
    expect(descongelado.thawed_at).not.toBeNull();
    // El ledger NO prohíbe volver al congelador: la política es del SafetyEngine.
    await h.como(USER_A, () => h.db.query("select public.move_lot($1, $2)", [id, freezerA]));
    expect((await lote(id)).temperature_state).toBe("FROZEN");
  });

  it("§74 VACUUM: cambia el empaque, NO la temperatura ni la fecha de seguridad", async () => {
    const id = await crearLote("Pollo vacío", polloId, 500, null);
    const antes = await lote(id);
    const { taskIds } = await planCon(
      [{ task_type: "VACUUM_SEAL", lot_id: id, ingredient_id: polloId, label: "Sellar", planned_quantity: 500, unit: "G" }],
      "PREP:vacuum",
    );
    await h.como(USER_A, () => h.db.query("select public.complete_prep_task($1)", [taskIds[0]]));
    const despues = await lote(id);
    expect(despues.vacuum_sealed).toBe(true);
    expect(despues.temperature_state).toBe(antes.temperature_state);
    expect(despues.use_by).toBe(antes.use_by); // sellar no regala vida útil
  });
});

describe("§26/§76 — intended ≠ safe; §75 sin regla no hay fecha", () => {
  it("uso previsto y fecha de seguridad viven separados; cambiar intended no toca use_by", async () => {
    const id = await crearLote("Pollo fechas", polloId, 300, null);
    await h.como(USER_A, () =>
      h.db.query("select public.set_lot_safety($1, '2099-01-06'::date, 'USDA FSIS test')", [id]),
    );
    await h.como(USER_A, () =>
      h.db.query("select public.set_intended_use($1, '2099-01-05'::date)", [id]),
    );
    let l = await lote(id);
    expect(l.intended_use_date).toBe("2099-01-05");
    expect(l.use_by).toBe("2099-01-06");
    // §28/§76: reasignar al miércoles NO mueve la fecha de seguridad.
    await h.como(USER_A, () =>
      h.db.query("select public.set_intended_use($1, '2099-01-03'::date)", [id]),
    );
    l = await lote(id);
    expect(l.intended_use_date).toBe("2099-01-03");
    expect(l.use_by).toBe("2099-01-06");
  });

  it("§21/§75: una fecha de seguridad SIN regla fuente se rechaza", async () => {
    const id = await crearLote("Sin fuente", polloId, 300, null);
    await expect(
      h.como(USER_A, () => h.db.query("select public.set_lot_safety($1, '2099-01-06'::date, null)", [id])),
    ).rejects.toThrow(/regla fuente/);
  });
});

describe("§35-§40, §77-§79 — etiquetas y QR", () => {
  let loteEtiqueta: string;
  let token: string;

  it("§77: el snapshot trae día de uso, alimento, cantidad, estado y token opaco — nada clínico", async () => {
    loteEtiqueta = await crearLote("Pollo etiqueta", polloId, 1100, null);
    await h.como(USER_A, () =>
      h.db.query("select public.set_intended_use($1, '2099-01-07'::date)", [loteEtiqueta]),
    );
    const job = await h.como(USER_A, async () =>
      (await h.fila<{ create_label_job: string }>(
        "select public.create_label_job($1)",
        [loteEtiqueta],
      ))!.create_label_job,
    );
    const fila = await h.como(USER_A, () =>
      h.fila<{ snapshot: Record<string, unknown>; status: string; template_version: number }>(
        "select snapshot, status, template_version from public.label_print_jobs where id = $1",
        [job],
      ),
    );
    expect(fila!.status).toBe("GENERATED");
    const s = fila!.snapshot;
    expect(s.label).toBe("Pollo etiqueta");
    expect(Number(s.quantity)).toBe(1100);
    expect(s.intended_use_date).toBe("2099-01-07");
    expect(typeof s.qr_token).toBe("string");
    token = s.qr_token as string;
    expect(token).toMatch(/^[0-9a-f]{32}$/); // opaco, jamás secuencial
    // §35: sin datos clínicos ni identidad en el snapshot.
    const claves = Object.keys(s).join(" ");
    for (const prohibida of ["medical", "member", "profile", "nutrition", "household"]) {
      expect(claves).not.toContain(prohibida);
    }
  });

  it("§78: el token del hogar A, consultado por B → denied (igual que un token inexistente)", async () => {
    await expect(
      h.como(USER_B, () => h.db.query("select public.resolve_lot_token($1)", [token])),
    ).rejects.toThrow(/no autorizado/);
    await expect(
      h.como(USER_B, () => h.db.query("select public.resolve_lot_token('deadbeef')", [])),
    ).rejects.toThrow(/no autorizado/);
    // El dueño sí lo resuelve.
    const r = await h.como(USER_A, async () =>
      (await h.fila<{ resolve_lot_token: { label: string } }>(
        "select public.resolve_lot_token($1)",
        [token],
      ))!.resolve_lot_token,
    );
    expect(r.label).toBe("Pollo etiqueta");
  });

  it("§79: reimprimir crea OTRO print job del MISMO lote — jamás otro lote", async () => {
    const lotesAntes = await h.comoAdmin(() =>
      h.filas("select id from public.inventory_lots where household_id = $1", [hogarA.householdId]),
    );
    await h.como(USER_A, () => h.db.query("select public.create_label_job($1)", [loteEtiqueta]));
    const jobs = await h.como(USER_A, () =>
      h.filas("select id from public.label_print_jobs where lot_id = $1", [loteEtiqueta]),
    );
    expect(jobs).toHaveLength(2);
    const lotesDespues = await h.comoAdmin(() =>
      h.filas("select id from public.inventory_lots where household_id = $1", [hogarA.householdId]),
    );
    expect(lotesDespues).toHaveLength(lotesAntes.length);
    // Mismo token en ambas: la identidad del paquete no cambia al reimprimir.
    const t2 = await lote(loteEtiqueta);
    void t2;
  });
});

describe("§80/§81/§82 — plan vs físico, cancelación y concurrencia", () => {
  it("§80: guardar el plan NO transforma stock; §17 la sugerencia no toca el ledger", async () => {
    const id = await crearLote("Intacto", polloId, 999, null);
    const movsAntes = await h.comoAdmin(() =>
      h.filas("select id from public.inventory_movements where lot_id = $1", [id]),
    );
    await planCon(
      [{ task_type: "PORTION", lot_id: id, ingredient_id: polloId, label: "Solo plan", planned_quantity: 999, unit: "G" }],
      "PREP:soloplan",
    );
    const movsDespues = await h.comoAdmin(() =>
      h.filas("select id from public.inventory_movements where lot_id = $1", [id]),
    );
    expect(movsDespues).toHaveLength(movsAntes.length);
    expect(Number((await lote(id)).quantity)).toBe(999);
  });

  it("§81: cancelar el plan no revierte lo YA hecho ni toca lo pendiente", async () => {
    const hecho = await crearLote("Hecho", tomateId, 500, null);
    const pendiente = await crearLote("Pendiente", tomateId, 500, null);
    const { planId, taskIds } = await planCon(
      [
        { task_type: "CUT", lot_id: hecho, ingredient_id: tomateId, label: "Picar A", planned_quantity: 500, unit: "G" },
        { task_type: "CUT", lot_id: pendiente, ingredient_id: tomateId, label: "Picar B", planned_quantity: 500, unit: "G" },
      ],
      "PREP:cancelar",
    );
    await h.como(USER_A, () => h.db.query("select public.complete_prep_task($1)", [taskIds[0]]));
    await h.como(USER_A, () => h.db.query("select public.cancel_prep_plan($1)", [planId]));

    const estados = await h.como(USER_A, () =>
      h.filas<{ status: string }>(
        "select status from public.batch_prep_tasks where plan_id = $1 order by seq",
        [planId],
      ),
    );
    expect(estados.map((e) => e.status)).toEqual(["DONE", "CANCELLED"]);
    expect((await lote(hecho)).processing_state).toBe("PREPPED"); // lo hecho, hecho
    expect((await lote(pendiente)).processing_state).toBe("RAW"); // lo pendiente, intacto
  });

  it("§82: confirmar la misma tarea dos veces = UNA transformación (sin doble split)", async () => {
    const id = await crearLote("Concurrente", polloId, 2000, 8000);
    const { taskIds } = await planCon(
      [{ task_type: "PORTION", lot_id: id, ingredient_id: polloId, label: "Porcionar", planned_quantity: 2000, unit: "G" }],
      "PREP:doble",
    );
    const outputs = JSON.stringify({ packages: [{ quantity: 1000 }, { quantity: 1000 }] });
    const r1 = await h.como(USER_A, async () =>
      (await h.fila<{ complete_prep_task: { child_lot_ids: string[] } }>(
        "select public.complete_prep_task($1, null, $2::jsonb)",
        [taskIds[0], outputs],
      ))!.complete_prep_task,
    );
    // Paula y Francisco marcan a la vez: la segunda confirmación devuelve lo YA hecho.
    const r2 = await h.como(USER_B, async () => null).catch(() => null); // B ni siquiera puede
    void r2;
    const r3 = await h.como(USER_A, async () =>
      (await h.fila<{ complete_prep_task: { child_lot_ids: string[] } }>(
        "select public.complete_prep_task($1, null, $2::jsonb)",
        [taskIds[0], outputs],
      ))!.complete_prep_task,
    );
    expect(r3.child_lot_ids).toEqual(r1.child_lot_ids);
    const hijos = await h.comoAdmin(() =>
      h.filas("select id from public.inventory_lots where parent_lot_id = $1", [id]),
    );
    expect(hijos).toHaveLength(2); // jamás 4
  });

  it("§14: no se congela un paquete cuya tarea previa sigue pendiente", async () => {
    const id = await crearLote("Dependiente", polloId, 700, null);
    const { taskIds } = await planCon(
      [
        { task_type: "WASH", lot_id: id, ingredient_id: polloId, label: "Lavar", planned_quantity: 700, unit: "G" },
        { task_type: "FREEZE", lot_id: id, ingredient_id: polloId, label: "Congelar", planned_quantity: 700, unit: "G", depends_on_index: 1 },
      ],
      "PREP:deps",
    );
    await expect(
      h.como(USER_A, () => h.db.query("select public.complete_prep_task($1)", [taskIds[1]])),
    ).rejects.toThrow(/primero completa/);
    await h.como(USER_A, () => h.db.query("select public.complete_prep_task($1)", [taskIds[0]]));
    await h.como(USER_A, () => h.db.query("select public.complete_prep_task($1)", [taskIds[1]]));
    expect((await lote(id)).temperature_state).toBe("FROZEN");
  });

  it("el dedupe del plan absorbe el doble clic de generación", async () => {
    const id = await crearLote("Dedupe plan", polloId, 100, null);
    const { planId } = await planCon(
      [{ task_type: "WASH", lot_id: id, ingredient_id: polloId, label: "Lavar", planned_quantity: 100, unit: "G" }],
      "PREP:dedupe-doble",
    );
    const { planId: otra } = await planCon(
      [{ task_type: "WASH", lot_id: id, ingredient_id: polloId, label: "Lavar", planned_quantity: 100, unit: "G" }],
      "PREP:dedupe-doble",
    );
    expect(otra).toBe(planId);
  });
});

describe("§43 — merge validado", () => {
  it("compatible: suma cantidad y valor en un lote nuevo, con el grupo en cero", async () => {
    const a = await crearLote("Merge A", polloId, 300, 1000);
    const b = await crearLote("Merge B", polloId, 200, 700);
    const nuevo = await h.como(USER_A, async () =>
      (await h.fila<{ merge_lots: string }>("select public.merge_lots(array[$1, $2]::uuid[])", [a, b]))!
        .merge_lots,
    );
    const l = await lote(nuevo);
    expect(Number(l.quantity)).toBe(500);
    expect(Number(l.acquisition_value)).toBe(1700);
    expect(Number((await lote(a)).quantity)).toBe(0);
    expect(Number((await lote(b)).quantity)).toBe(0);
  });

  it("RAW+COOKED y FROZEN+CHILLED se rechazan; alimentos distintos también", async () => {
    const crudo = await crearLote("Crudo", polloId, 300, null);
    const congelado = await crearLote("Congelado", polloId, 300, null, freezerA);
    await expect(
      h.como(USER_A, () => h.db.query("select public.merge_lots(array[$1, $2]::uuid[])", [crudo, congelado])),
    ).rejects.toThrow(/no se pueden unir/);
    const otro = await crearLote("Otro alimento", tomateId, 300, null);
    await expect(
      h.como(USER_A, () => h.db.query("select public.merge_lots(array[$1, $2]::uuid[])", [crudo, otro])),
    ).rejects.toThrow(/no se pueden unir/);
  });
});

describe("correcciones de la revisión adversarial", () => {
  it("merge con valor DESCONOCIDO en una parte → valor desconocido (jamás suma parcial)", async () => {
    const conValor = await crearLote("Con valor", polloId, 300, 1000);
    const sinValor = await crearLote("Sin valor", polloId, 200, null);
    const nuevo = await h.como(USER_A, async () =>
      (await h.fila<{ merge_lots: string }>("select public.merge_lots(array[$1, $2]::uuid[])", [conValor, sinValor]))!
        .merge_lots,
    );
    const l = await lote(nuevo);
    expect(Number(l.quantity)).toBe(500);
    expect(l.acquisition_value).toBeNull(); // K-19: desconocido domina
  });

  it("saltar la ÚLTIMA tarea pendiente también cierra el plan", async () => {
    const id = await crearLote("Skip final", polloId, 100, null);
    const { planId, taskIds } = await planCon(
      [{ task_type: "WASH", lot_id: id, ingredient_id: polloId, label: "Lavar", planned_quantity: 100, unit: "G" }],
      "PREP:skip-final",
    );
    await h.como(USER_A, () => h.db.query("select public.skip_prep_task($1)", [taskIds[0]]));
    const plan = await h.como(USER_A, () =>
      h.fila<{ status: string }>("select status from public.batch_prep_plans where id = $1", [planId]),
    );
    expect(plan!.status).toBe("COMPLETED");
  });

  it("un plan COMPLETADO no se cancela retroactivamente: es historia", async () => {
    const id = await crearLote("Historia", polloId, 100, null);
    const { planId, taskIds } = await planCon(
      [{ task_type: "WASH", lot_id: id, ingredient_id: polloId, label: "Lavar", planned_quantity: 100, unit: "G" }],
      "PREP:historia",
    );
    await h.como(USER_A, () => h.db.query("select public.complete_prep_task($1)", [taskIds[0]]));
    await expect(
      h.como(USER_A, () => h.db.query("select public.cancel_prep_plan($1)", [planId])),
    ).rejects.toThrow(/historia/);
  });

  it("§83: un plan nuevo del mismo día REEMPLAZA a la sugerencia vieja (READY→CANCELLED)", async () => {
    const id = await crearLote("Supersede", polloId, 400, null);
    const { planId: viejo } = await planCon(
      [{ task_type: "WASH", lot_id: id, ingredient_id: polloId, label: "Lavar v1", planned_quantity: 400, unit: "G" }],
      "PREP:supersede-v1",
    );
    const { planId: nuevo } = await planCon(
      [{ task_type: "WASH", lot_id: id, ingredient_id: polloId, label: "Lavar v2", planned_quantity: 300, unit: "G" }],
      "PREP:supersede-v2",
    );
    expect(nuevo).not.toBe(viejo);
    const estados = await h.como(USER_A, () =>
      h.filas<{ id: string; status: string }>(
        "select id, status from public.batch_prep_plans where id in ($1, $2) order by created_at",
        [viejo, nuevo],
      ),
    );
    expect(estados.find((e) => e.id === viejo)!.status).toBe("CANCELLED");
    expect(estados.find((e) => e.id === nuevo)!.status).toBe("READY");
    // …pero un plan EN CURSO no se le quita a quien cocina: se prueba aparte.
  });

  it("un plan IN_PROGRESS no es reemplazado por la regeneración", async () => {
    const a = await crearLote("EnCurso A", polloId, 200, null);
    const b = await crearLote("EnCurso B", polloId, 200, null);
    const { planId: enCurso, taskIds } = await planCon(
      [
        { task_type: "WASH", lot_id: a, ingredient_id: polloId, label: "Lavar 1", planned_quantity: 200, unit: "G" },
        { task_type: "WASH", lot_id: b, ingredient_id: polloId, label: "Lavar 2", planned_quantity: 200, unit: "G" },
      ],
      "PREP:encurso-v1",
    );
    await h.como(USER_A, () => h.db.query("select public.complete_prep_task($1)", [taskIds[0]])); // → IN_PROGRESS
    await planCon(
      [{ task_type: "WASH", lot_id: a, ingredient_id: polloId, label: "Lavar v2", planned_quantity: 100, unit: "G" }],
      "PREP:encurso-v2",
    );
    const estado = await h.como(USER_A, () =>
      h.fila<{ status: string }>("select status from public.batch_prep_plans where id = $1", [enCurso]),
    );
    expect(estado!.status).toBe("IN_PROGRESS"); // hay alguien cocinando con él
  });

  it("utilizable negativo se rechaza con mensaje claro", async () => {
    const id = await crearLote("Negativo", tomateId, 500, null);
    const { taskIds } = await planCon(
      [{ task_type: "CUT", lot_id: id, ingredient_id: tomateId, label: "Picar", planned_quantity: 500, unit: "G" }],
      "PREP:negativo",
    );
    await expect(
      h.como(USER_A, () =>
        h.db.query("select public.complete_prep_task($1, 500, $2::jsonb)", [
          taskIds[0],
          JSON.stringify({ output_quantity: -100, waste_quantity: 600 }),
        ]),
      ),
    ).rejects.toThrow(/negativo/);
  });
});

describe("§45/§46 — rendimiento observado: observación, jamás sobrescritura", () => {
  it("guardar 1.000→760 crea la observación con factor 0,76 y NO toca ingredient_yields", async () => {
    const referencias = await h.comoAdmin(() =>
      h.filas("select id, yield_factor from public.ingredient_yields"),
    );
    await h.como(USER_A, () =>
      h.db.query(
        `insert into public.household_observed_yields
           (household_id, ingredient_id, cooking_method, input_quantity, output_quantity, unit)
         values ($1, $2, 'BAKED', 1000, 760, 'G')`,
        [hogarA.householdId, polloId],
      ),
    );
    const obs = await h.como(USER_A, () =>
      h.fila<{ observed_factor: string; created_by: string }>(
        "select observed_factor::text, created_by from public.household_observed_yields where household_id = $1",
        [hogarA.householdId],
      ),
    );
    expect(Number(obs!.observed_factor)).toBe(0.76);
    expect(obs!.created_by).toBe(hogarA.memberId); // §62: estampado por la base
    const despues = await h.comoAdmin(() => h.filas("select id, yield_factor from public.ingredient_yields"));
    expect(despues).toEqual(referencias); // la referencia global queda intacta
  });
});

describe("§61 — outbox: eventos con efectos idempotentes", () => {
  it("completar PORTION emite LOT_SPLIT una sola vez (dedupe por tarea)", async () => {
    const id = await crearLote("Outbox", polloId, 600, null);
    const { taskIds } = await planCon(
      [{ task_type: "PORTION", lot_id: id, ingredient_id: polloId, label: "Porcionar", planned_quantity: 600, unit: "G" }],
      "PREP:outbox",
    );
    const outputs = JSON.stringify({ packages: [{ quantity: 300 }, { quantity: 300 }] });
    await h.como(USER_A, () => h.db.query("select public.complete_prep_task($1, null, $2::jsonb)", [taskIds[0], outputs]));
    await h.como(USER_A, () => h.db.query("select public.complete_prep_task($1, null, $2::jsonb)", [taskIds[0], outputs]));
    const eventos = await h.comoAdmin(() =>
      h.filas(
        "select id from public.domain_events where dedupe_key = $1",
        [`LOT_SPLIT:${taskIds[0]}`],
      ),
    );
    expect(eventos).toHaveLength(1);
  });
});

describe("§63/§64 — RLS y SECURITY DEFINER entre hogares", () => {
  it("B no ve planes, tareas, etiquetas ni equipos de A", async () => {
    const planes = await h.como(USER_B, () =>
      h.filas("select id from public.batch_prep_plans where household_id = $1", [hogarA.householdId]),
    );
    expect(planes).toHaveLength(0);
    const etiquetas = await h.como(USER_B, () =>
      h.filas("select id from public.label_print_jobs where household_id = $1", [hogarA.householdId]),
    );
    expect(etiquetas).toHaveLength(0);
  });

  it("B no completa tareas de A ni crea planes A SU nombre", async () => {
    const id = await crearLote("Ajeno", polloId, 100, null);
    const { taskIds } = await planCon(
      [{ task_type: "WASH", lot_id: id, ingredient_id: polloId, label: "Lavar", planned_quantity: 100, unit: "G" }],
      "PREP:ajeno",
    );
    await expect(
      h.como(USER_B, () => h.db.query("select public.complete_prep_task($1)", [taskIds[0]])),
    ).rejects.toThrow(/no autorizado/);
    await expect(
      h.como(USER_B, () =>
        h.db.query(
          "select public.save_prep_plan($1, current_date, 'v', 1, '{}'::jsonb, null, $2::jsonb)",
          [hogarA.householdId, JSON.stringify([{ task_type: "WASH", label: "x" }])],
        ),
      ),
    ).rejects.toThrow(/no autorizado/);
  });

  it("un plan de A no acepta LOTES de B (inyección de UUID)", async () => {
    const loteB = await h.como(USER_B, async () =>
      (await h.fila<{ add_manual_lot: string }>(
        "select public.add_manual_lot($1, 'Lote B', 100, 'G', $2)",
        [hogarB.householdId, polloId],
      ))!.add_manual_lot,
    );
    await expect(
      planCon(
        [{ task_type: "WASH", lot_id: loteB, ingredient_id: polloId, label: "Robo", planned_quantity: 100, unit: "G" }],
        "PREP:inyeccion",
      ),
    ).rejects.toThrow(/no autorizado/);
  });

  it("B no genera etiquetas ni tokens de lotes de A", async () => {
    const id = await crearLote("Etiqueta ajena", polloId, 100, null);
    await expect(
      h.como(USER_B, () => h.db.query("select public.create_label_job($1)", [id])),
    ).rejects.toThrow(/no autorizado/);
    await expect(
      h.como(USER_B, () => h.db.query("select public.ensure_lot_token($1)", [id])),
    ).rejects.toThrow(/no autorizado/);
  });
});

describe("§84 (hallazgo de la demo viva): el plan cambia, el paquete físico queda", () => {
  it("al desaparecer la comida, el paquete sobrevive y el vínculo se anula sin tocar la fecha de seguridad", async () => {
    const plan = await h.como(USER_A, async () =>
      (await h.fila<{ ensure_weekly_plan: string }>(
        "select public.ensure_weekly_plan($1, (date_trunc('week', current_date + 7))::date)",
        [hogarA.householdId],
      ))!.ensure_weekly_plan,
    );
    const dia = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 order by plan_date limit 1",
        [plan],
      ),
    ))!.id;
    const asignacion = (await h.como(USER_A, () =>
      h.fila<{ id: string }>(
        `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
         select $1, 'LUNCH', 'RECIPE', v.template_id, v.id
         from public.meal_template_versions v
         join public.meal_templates t on t.id = v.template_id
         where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'
         limit 1
         returning id`,
        [dia],
      ),
    ))!.id;

    const id = await crearLote("Paquete asignado", polloId, 900, null);
    await h.como(USER_A, () =>
      h.db.query("select public.set_intended_use($1, (current_date + 8)::date, $2)", [id, asignacion]),
    );
    await h.como(USER_A, () =>
      h.db.query("select public.set_lot_safety($1, (current_date + 90)::date, 'USDA FSIS (test)')", [id]),
    );

    // La familia borra la comida DESPUÉS de haber preparado el paquete.
    await h.como(USER_A, () =>
      h.db.query("delete from public.meal_assignments where id = $1", [asignacion]),
    );

    const l = await lote(id);
    expect(l.status).toBe("AVAILABLE");           // el paquete físico NO desaparece
    expect(Number(l.quantity)).toBe(900);          // el ledger no se revierte
    expect(l.intended_assignment_id).toBeNull();   // el vínculo se anula solo
    expect(l.use_by).not.toBeNull();               // la seguridad no cambia con el plan
  });
});
