import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, effectiveDate, weekStart } from "@/domain/nutrition/calendar";
import { planPrep } from "@/domain/prep/engine";
import { generateLabelsPdf, labelSnapshotSchema } from "@/lib/labels/pdf";
import type { PrepEngineInput, SafetyRule, SuggestedPackage } from "@/domain/prep/types";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * DEMO LOCAL OBLIGATORIA (§90) — sin fingir Supabase remoto: PGlite con las
 * migraciones 0001→0015 y el MOTOR real alimentado desde filas reales.
 *
 * Compra recibida (pollo 4.200 g + zanahoria 2 kg + tomate 1,5 kg), plan
 * semanal confirmado, BatchPrepPlan generado, y las diez demostraciones A-J.
 */

const USER_A = "00000000-0000-0000-0000-0000000000f5";

let h: Harness;
let hogar: { householdId: string; memberId: string };
let polloId: string;
let zanahoriaId: string;
let tomateId: string;
let versionPollo: string;
let perfil: string;
let fridge: string;
let freezer: string;
let capShred4: string;

const HOY = effectiveDate(new Date(), "America/Santiago");
const MARTES = addDays(HOY, 1);
const VIERNES = addDays(HOY, 3);
const DOMINGO = addDays(HOY, 5);

async function asignacionEn(fecha: string): Promise<string> {
  return h.como(USER_A, async () => {
    const planId = (await h.fila<{ ensure_weekly_plan: string }>(
      "select public.ensure_weekly_plan($1, $2::date)",
      [hogar.householdId, weekStart(fecha)],
    ))!.ensure_weekly_plan;
    const dia = (await h.fila<{ id: string }>(
      "select id from public.weekly_plan_days where plan_id = $1 and plan_date = $2",
      [planId, fecha],
    ))!.id;
    return (await h.fila<{ id: string }>(
      `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
       select $1, 'LUNCH', 'RECIPE', v.template_id, v.id
       from public.meal_template_versions v where v.id = $2
       returning id`,
      [dia, versionPollo],
    ))!.id;
  });
}

async function confirmar(
  asignacion: string,
  fecha: string,
  componentes: { id: string; label: string; qty: number }[],
) {
  await h.como(USER_A, async () => {
    await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
      asignacion,
      JSON.stringify([
        {
          member_id: hogar.memberId,
          version_id: versionPollo,
          profile_id: perfil,
          optimizer_version: "portion-optimizer/1.0.0",
          meal_type: "LUNCH",
          serving_date: fecha,
          fit: "COMPATIBLE",
          adaptation_level: 0,
          score: 90,
          nutrition: {},
          completeness: {},
          reasons: [],
          unmet_constraints: [],
          components: componentes.map((c, i) => ({
            label: c.label,
            base_quantity: c.qty,
            proposed_quantity: c.qty,
            unit: "G",
            weight_basis: "RAW",
            cooking_method: "BAKED",
            added_fat_g: 0,
            sort_order: i + 1,
            ingredient_id: c.id,
          })),
          substitutions: [],
        },
      ]),
    ]);
  });
}

/** El insumo del motor, construido desde la BASE (la costura del cargador). */
async function prepInputDesdeBase(): Promise<PrepEngineInput> {
  return h.como(USER_A, async () => {
    const lots = (
      await h.filas<{
        id: string; ingredient_id: string; label: string; quantity: string; unit: string;
        processing_state: string; temperature_state: string; vacuum_sealed: boolean;
        use_by: string | null; expiry_date: string | null; created_at: string;
        intended_use_date: string | null; category_id: string | null; kind: string | null;
      }>(
        `select l.id, l.ingredient_id, l.label, l.quantity::text, l.unit,
                l.processing_state::text, l.temperature_state::text, l.vacuum_sealed,
                l.use_by::text, l.expiry_date::text, l.created_at::text,
                l.intended_use_date::text, i.category_id, s.kind::text
         from public.inventory_lots l
         join public.ingredients i on i.id = l.ingredient_id
         left join public.storage_locations s on s.id = l.location_id
         where l.household_id = $1 and l.status = 'AVAILABLE' and l.quantity > 0`,
        [hogar.householdId],
      )
    ).map((l) => ({
      id: l.id,
      ingredientId: l.ingredient_id,
      categoryId: l.category_id,
      label: l.label,
      quantity: Number(l.quantity),
      unit: l.unit as "G",
      processingState: l.processing_state as "RAW",
      temperatureState: l.temperature_state as "CHILLED",
      vacuumSealed: l.vacuum_sealed,
      locationKind: (l.kind ?? null) as "FRIDGE" | null,
      useBy: l.use_by,
      expiryDate: l.expiry_date,
      createdOn: effectiveDate(new Date(l.created_at), "America/Santiago"),
      intendedUseDate: l.intended_use_date,
    }));

    const demand = (
      await h.filas<{
        assignment_id: string; serving_date: string; meal_type: string;
        ingredient_id: string; proposed_quantity: string; unit: string;
      }>(
        `select p.assignment_id, p.serving_date::text, p.meal_type::text,
                c.ingredient_id, c.proposed_quantity::text, c.unit::text
         from public.member_serving_projections p
         join public.member_serving_components c on c.projection_id = p.id
         where p.member_id = $1 and p.status = 'PLANNED' and p.serving_date >= $2
           and c.ingredient_id is not null`,
        [hogar.memberId, HOY],
      )
    ).map((d) => ({
      assignmentId: d.assignment_id,
      date: d.serving_date,
      mealType: d.meal_type,
      ingredientId: d.ingredient_id,
      quantity: Number(d.proposed_quantity),
      unit: d.unit as "G",
    }));

    const preferences = (
      await h.filas<{
        ingredient_id: string; task_type: string; params: Record<string, unknown>;
        capability_id: string | null; manual_alternative: string | null;
      }>(
        "select ingredient_id, task_type, params, capability_id, manual_alternative from public.prep_preferences where household_id = $1 and is_active",
        [hogar.householdId],
      )
    ).map((p) => ({
      ingredientId: p.ingredient_id,
      taskType: p.task_type as "SHRED",
      params: p.params,
      capabilityId: p.capability_id,
      manualAlternative: p.manual_alternative,
    }));

    const capabilities = (
      await h.filas<{
        id: string; equipment_id: string; capability: string; params: Record<string, unknown>;
        max_batch_quantity: string | null; is_active: boolean; name: string; eq_active: boolean;
      }>(
        `select c.id, c.equipment_id, c.capability, c.params, c.max_batch_quantity::text,
                c.is_active, e.name, e.is_active as eq_active
         from public.household_equipment_configs c
         join public.household_equipment e on e.id = c.equipment_id
         where e.household_id = $1`,
        [hogar.householdId],
      )
    ).map((c) => ({
      id: c.id,
      equipmentId: c.equipment_id,
      equipmentName: c.name,
      equipmentActive: c.eq_active,
      capability: c.capability,
      params: c.params,
      maxBatchQuantity: c.max_batch_quantity == null ? null : Number(c.max_batch_quantity),
      isActive: c.is_active,
    }));

    const safetyRules: SafetyRule[] = (
      await h.filas<{
        id: string; household_id: string | null; ingredient_id: string | null;
        category_id: string | null; processing_state: string | null;
        temperature_state: string | null; vacuum_sealed: boolean | null;
        rule_kind: string; max_days: number | null; use_soon_within_days: number;
        refreeze_allowed: boolean | null; thaw_fridge_hours: number | null; source: string;
      }>(
        `select id, household_id, ingredient_id, category_id, processing_state::text,
                temperature_state::text, vacuum_sealed, rule_kind, max_days,
                use_soon_within_days, refreeze_allowed, thaw_fridge_hours, source
         from public.storage_safety_rules where is_active`,
      )
    ).map((r) => ({
      id: r.id,
      isHousehold: r.household_id != null,
      ingredientId: r.ingredient_id,
      categoryId: r.category_id,
      processingState: r.processing_state as "RAW" | null,
      temperatureState: r.temperature_state as "CHILLED" | null,
      vacuumSealed: r.vacuum_sealed,
      ruleKind: r.rule_kind as "STORAGE_DAYS",
      maxDays: r.max_days,
      useSoonWithinDays: r.use_soon_within_days,
      refreezeAllowed: r.refreeze_allowed,
      thawFridgeHours: r.thaw_fridge_hours,
      source: r.source,
    }));

    return {
      today: HOY,
      horizonDays: 7,
      lots,
      demand,
      preferences,
      capabilities,
      safetyRules,
      freezerCapacityKnown: null,
    };
  });
}

let lotePollo: string;
let loteZanahoria: string;
let planId: string;
let taskIds: string[] = [];
let hijosPollo: string[] = [];
let asignaciones: string[] = [];

beforeAll(async () => {
  h = await levantarBase();
  hogar = await crearHogar(h, USER_A, "Hogar Demo 10", "Fran");

  polloId = (await h.fila<{ id: string }>("select id from public.ingredients where canonical_name = 'pechuga de pollo sin piel'"))!.id;
  zanahoriaId = (await h.fila<{ id: string }>("select id from public.ingredients where canonical_name = 'zanahoria'"))!.id;
  tomateId = (await h.fila<{ id: string }>("select id from public.ingredients where canonical_name = 'tomate'"))!.id;
  versionPollo = (await h.fila<{ id: string }>(
    `select v.id from public.meal_template_versions v
     join public.meal_templates t on t.id = v.template_id
     where t.name = 'Pollo con arroz y ensalada chilena' and v.status = 'PUBLISHED'`,
  ))!.id;

  await h.como(USER_A, () => h.db.query("select public.ensure_storage_locations($1)", [hogar.householdId]));
  fridge = (await h.fila<{ id: string }>(
    "select id from public.storage_locations where household_id = $1 and kind = 'FRIDGE' limit 1",
    [hogar.householdId],
  ))!.id;
  freezer = (await h.fila<{ id: string }>(
    "select id from public.storage_locations where household_id = $1 and kind = 'FREEZER' limit 1",
    [hogar.householdId],
  ))!.id;

  await h.como(USER_A, async () => {
    perfil = (await h.fila<{ publish_nutrition_profile: string }>(
      `select public.publish_nutrition_profile($1, 'BASIC', 'firma-demo10', '{}'::jsonb,
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'demo')`,
      [hogar.memberId],
    ))!.publish_nutrition_profile;

    // Equipamiento real de la casa: cortadora con cuchilla de rallado 4 mm.
    const equipo = (await h.fila<{ id: string }>(
      "insert into public.household_equipment (household_id, name) values ($1, 'Cortadora de verduras') returning id",
      [hogar.householdId],
    ))!.id;
    capShred4 = (await h.fila<{ id: string }>(
      `insert into public.household_equipment_configs (equipment_id, capability, params)
       values ($1, 'CUT_SHRED', '{"size_mm": 4}'::jsonb) returning id`,
      [equipo],
    ))!.id;

    // Preferencias: zanahoria se lava y ralla (equipo); tomate se lava y pica (a mano).
    await h.db.query(
      `insert into public.prep_preferences (household_id, ingredient_id, task_type, params, capability_id, manual_alternative)
       values ($1, $2, 'WASH', '{}'::jsonb, null, null),
              ($1, $2, 'SHRED', '{"size_mm": 4}'::jsonb, $3, 'rallador manual'),
              ($1, $4, 'WASH', '{}'::jsonb, null, null),
              ($1, $4, 'CUT', '{}'::jsonb, null, 'cuchillo y tabla')`,
      [hogar.householdId, zanahoriaId, capShred4, tomateId],
    );
  });

  // Compra recibida (§90): los lotes con su valor.
  lotePollo = await h.como(USER_A, async () =>
    (await h.fila<{ add_manual_lot: string }>(
      "select public.add_manual_lot($1, 'Pechuga de pollo', 4200, 'G', $2, $3)",
      [hogar.householdId, polloId, fridge],
    ))!.add_manual_lot,
  );
  loteZanahoria = await h.como(USER_A, async () =>
    (await h.fila<{ add_manual_lot: string }>(
      "select public.add_manual_lot($1, 'Zanahoria', 2000, 'G', $2, $3)",
      [hogar.householdId, zanahoriaId, fridge],
    ))!.add_manual_lot,
  );
  await h.como(USER_A, () =>
    h.db.query("select public.add_manual_lot($1, 'Tomate', 1500, 'G', $2, $3)", [
      hogar.householdId,
      tomateId,
      fridge,
    ]),
  );
  await h.comoAdmin(() =>
    h.db.query("update public.inventory_lots set acquisition_value = 17003 where id = $1", [lotePollo]),
  );

  // Plan semanal confirmado: martes/viernes/domingo con pollo + verduras.
  const aMartes = await asignacionEn(MARTES);
  const aViernes = await asignacionEn(VIERNES);
  const aDomingo = await asignacionEn(DOMINGO);
  asignaciones = [aMartes, aViernes, aDomingo];
  await confirmar(aMartes, MARTES, [
    { id: polloId, label: "Pechuga de pollo", qty: 1100 },
    { id: zanahoriaId, label: "Zanahoria rallada", qty: 600 },
    { id: tomateId, label: "Tomate picado", qty: 700 },
  ]);
  await confirmar(aViernes, VIERNES, [{ id: polloId, label: "Pechuga de pollo", qty: 1300 }]);
  await confirmar(aDomingo, DOMINGO, [{ id: polloId, label: "Pechuga de pollo", qty: 900 }]);
}, 60000);

afterAll(async () => {
  await h.cerrar();
});

describe("§90 — demo local completa", () => {
  it("el motor genera el plan desde filas reales: pollo por días, zanahoria con equipo, tomate parcial", async () => {
    const input = await prepInputDesdeBase();
    const draft = planPrep(input);

    // A. Pollo dividido por días + reserva.
    const portionPollo = draft.tasks.find((t) => t.taskType === "PORTION" && t.lotId === lotePollo)!;
    const paquetes = portionPollo.params.packages!;
    expect(paquetes.map((p) => p.quantity)).toEqual([1100, 1300, 900, 900]);
    expect(paquetes.map((p) => p.intendedUseDate)).toEqual([MARTES, VIERNES, DOMINGO, null]);

    // B. Parte refrigerada y parte congelada — según las reglas USDA sembradas.
    expect(paquetes[0]!.storage).toBe("REFRIGERATE"); // martes cabe en 2 días
    expect(paquetes[1]!.storage).toBe("FREEZE"); // viernes no
    expect(paquetes[3]!.storage).toBe("FREEZE"); // la reserva, congelada

    // C. Zanahoria con corte por capability del equipo (4 mm).
    const shred = draft.tasks.find((t) => t.taskType === "SHRED")!;
    expect(shred.params.equipmentName).toBe("Cortadora de verduras");
    expect(shred.params.cutLabel).toBe("SHRED 4 mm");
    expect(shred.plannedQuantity).toBe(600);
    expect(shred.params.manualAlternative).toBe("rallador manual");

    // D. Tomates parcialmente preparados y el resto ENTERO, con razón.
    const tomateWhole = draft.leaveWhole.find((l) => l.ingredientId === tomateId)!;
    expect(tomateWhole.quantity).toBe(800); // 1.500 − 700
    const zanaWhole = draft.leaveWhole.find((l) => l.ingredientId === zanahoriaId)!;
    expect(zanaWhole.quantity).toBe(1400); // 2.000 − 600

    // Guardar el plan (§17: nada cambia en la despensa todavía).
    const antes = await h.comoAdmin(() =>
      h.fila<{ n: string }>(
        "select count(*)::text as n from public.inventory_movements where household_id = $1",
        [hogar.householdId],
      ),
    );
    planId = await h.como(USER_A, async () =>
      (await h.fila<{ save_prep_plan: string }>(
        "select public.save_prep_plan($1, $2::date, $3, $4, $5::jsonb, $6, $7::jsonb)",
        [
          hogar.householdId,
          HOY,
          draft.engineVersion,
          draft.complexity,
          JSON.stringify(draft.summary),
          `PREP:demo:${HOY}`,
          JSON.stringify(
            draft.tasks.map((t) => ({
              block_label: t.blockLabel,
              task_type: t.taskType,
              lot_id: t.lotId,
              ingredient_id: t.ingredientId,
              label: t.label,
              planned_quantity: t.plannedQuantity,
              unit: t.unit,
              params: t.params,
              depends_on_index: t.dependsOnIndex,
            })),
          ),
        ],
      ))!.save_prep_plan,
    );
    const despues = await h.comoAdmin(() =>
      h.fila<{ n: string }>(
        "select count(*)::text as n from public.inventory_movements where household_id = $1",
        [hogar.householdId],
      ),
    );
    expect(despues!.n).toBe(antes!.n); // generar plan ≠ transformar stock (§80)

    taskIds = (
      await h.como(USER_A, () =>
        h.filas<{ id: string; task_type: string }>(
          "select id, task_type from public.batch_prep_tasks where plan_id = $1 order by seq",
          [planId],
        ),
      )
    ).map((t) => t.id);
    expect(taskIds.length).toBeGreaterThanOrEqual(5);
  });

  it("G/H: completar tareas — el ledger conserva cantidad y valor al gramo y al peso", async () => {
    const tareas = await h.como(USER_A, () =>
      h.filas<{ id: string; task_type: string; lot_id: string | null; params: { packages?: SuggestedPackage[] } }>(
        "select id, task_type, lot_id, params from public.batch_prep_tasks where plan_id = $1 order by seq",
        [planId],
      ),
    );

    for (const t of tareas) {
      if (t.task_type === "PORTION" && t.lot_id === lotePollo) {
        const paquetes = t.params.packages!.map((p) => ({
          quantity: p.quantity,
          location_id: p.storage === "FREEZE" ? freezer : p.storage === "REFRIGERATE" ? fridge : null,
          intended_use_date: p.intendedUseDate,
          intended_assignment_id: p.intendedAssignmentId,
        }));
        const r = await h.como(USER_A, async () =>
          (await h.fila<{ complete_prep_task: { child_lot_ids: string[] } }>(
            "select public.complete_prep_task($1, null, $2::jsonb)",
            [t.id, JSON.stringify({ packages: paquetes })],
          ))!.complete_prep_task,
        );
        hijosPollo = r.child_lot_ids;
      } else {
        await h.como(USER_A, () => h.db.query("select public.complete_prep_task($1)", [t.id]));
      }
    }

    // H. Conservación: Σ hijos = 4.200 g y Σ valores = $17.003 exactos.
    const hijos = await h.comoAdmin(() =>
      h.filas<{ quantity: string; acquisition_value: string; temperature_state: string; intended_use_date: string | null }>(
        `select quantity::text, acquisition_value::text, temperature_state::text, intended_use_date::text
         from public.inventory_lots where parent_lot_id = $1 order by created_at`,
        [lotePollo],
      ),
    );
    expect(hijos).toHaveLength(4);
    expect(hijos.reduce((acc, x) => acc + Number(x.quantity), 0)).toBe(4200);
    expect(hijos.reduce((acc, x) => acc + Number(x.acquisition_value), 0)).toBeCloseTo(17003, 4);

    // B (físico): martes quedó refrigerado, viernes/reserva congelados.
    expect(hijos.filter((x) => x.temperature_state === "FROZEN").length).toBe(3);
    expect(hijos.filter((x) => x.temperature_state === "CHILLED").length).toBe(1);

    // La zanahoria quedó PREPPED con solo 600 g preparados (1.400 intactos).
    const zana = await h.comoAdmin(() =>
      h.fila<{ quantity: string; processing_state: string }>(
        "select quantity::text, processing_state::text from public.inventory_lots where id = $1",
        [loteZanahoria],
      ),
    );
    expect(Number(zana!.quantity)).toBe(1400);
    expect(zana!.processing_state).toBe("RAW"); // el lote madre sigue crudo
    const zanaHija = await h.comoAdmin(() =>
      h.fila<{ quantity: string; processing_state: string }>(
        "select quantity::text, processing_state::text from public.inventory_lots where parent_lot_id = $1",
        [loteZanahoria],
      ),
    );
    expect(Number(zanaHija!.quantity)).toBe(600);
    expect(zanaHija!.processing_state).toBe("PREPPED");

    const plan = await h.como(USER_A, () =>
      h.fila<{ status: string }>("select status from public.batch_prep_plans where id = $1", [planId]),
    );
    expect(plan!.status).toBe("COMPLETED");
  });

  it("E: etiquetas PDF reales de los paquetes, desde snapshots congelados", async () => {
    const jobs: string[] = [];
    for (const hijo of hijosPollo) {
      const job = await h.como(USER_A, async () =>
        (await h.fila<{ create_label_job: string }>("select public.create_label_job($1)", [hijo]))!
          .create_label_job,
      );
      jobs.push(job);
    }
    const snapshots = await h.como(USER_A, () =>
      h.filas<{ snapshot: unknown }>(
        "select snapshot from public.label_print_jobs where id = any($1::uuid[])",
        [jobs],
      ),
    );
    const parsed = snapshots.map((s) => labelSnapshotSchema.parse(s.snapshot));
    const pdf = await generateLabelsPdf(parsed, "https://mesa.familia");
    expect(String.fromCharCode(...pdf.slice(0, 5))).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(4000); // 4 páginas con QR de verdad
  });

  it("F: la acción del QR funciona en local — resolver y usar una parte", async () => {
    const token = await h.como(USER_A, async () =>
      (await h.fila<{ ensure_lot_token: string }>(
        "select public.ensure_lot_token($1)",
        [hijosPollo[0]],
      ))!.ensure_lot_token,
    );
    const vista = await h.como(USER_A, async () =>
      (await h.fila<{ resolve_lot_token: { quantity: number } }>(
        "select public.resolve_lot_token($1)",
        [token],
      ))!.resolve_lot_token,
    );
    expect(Number(vista.quantity)).toBe(1100);
    await h.como(USER_A, () => h.db.query("select public.use_lot($1, 400)", [hijosPollo[0]!]));
    const despues = await h.comoAdmin(() =>
      h.fila<{ quantity: string }>("select quantity::text from public.inventory_lots where id = $1", [hijosPollo[0]]),
    );
    expect(Number(despues!.quantity)).toBe(700);
  });

  it("I/J: cambiar la planificación DESPUÉS del prep no borra paquetes — quedan 'sin asignar'", async () => {
    // El paquete del viernes existe con su asignación prevista.
    const paqueteViernes = await h.comoAdmin(() =>
      h.fila<{ id: string; intended_assignment_id: string | null; package_code: string | null }>(
        `select id, intended_assignment_id, package_code from public.inventory_lots
         where parent_lot_id = $1 and intended_use_date = $2`,
        [lotePollo, VIERNES],
      ),
    );
    expect(paqueteViernes!.intended_assignment_id).toBe(asignaciones[1]);

    // La familia cambia de idea: se borra la comida del viernes.
    await h.como(USER_A, () =>
      h.db.query("delete from public.meal_assignments where id = $1", [asignaciones[1]]),
    );

    const despues = await h.comoAdmin(() =>
      h.fila<{ status: string; quantity: string; intended_assignment_id: string | null; package_code: string | null }>(
        "select status, quantity::text, intended_assignment_id, package_code from public.inventory_lots where id = $1",
        [paqueteViernes!.id],
      ),
    );
    expect(despues!.status).toBe("AVAILABLE"); // J: el paquete físico NO desaparece
    expect(Number(despues!.quantity)).toBe(1300);
    expect(despues!.intended_assignment_id).toBeNull(); // "ya no está asignado a una comida"
    expect(despues!.package_code).toBe(paqueteViernes!.package_code); // identidad intacta

    // Puede reasignarse (§28): a otra comida, sin tocar la fecha de seguridad.
    await h.como(USER_A, () =>
      h.db.query("select public.set_intended_use($1, $2::date, $3)", [
        paqueteViernes!.id,
        DOMINGO,
        asignaciones[2],
      ]),
    );
    const reasignado = await h.comoAdmin(() =>
      h.fila<{ intended_use_date: string }>(
        "select intended_use_date::text from public.inventory_lots where id = $1",
        [paqueteViernes!.id],
      ),
    );
    expect(reasignado!.intended_use_date).toBe(DOMINGO);
  });

  it("§85: sobras cocinadas — 200 g COOKED como lote, etiquetables", async () => {
    const sobra = await h.como(USER_A, async () =>
      (await h.fila<{ add_manual_lot: string }>(
        "select public.add_manual_lot($1, 'Pollo cocido (sobra)', 200, 'G', $2, $3, null, $4)",
        [hogar.householdId, polloId, fridge, asignaciones[0]],
      ))!.add_manual_lot,
    );
    const l = await h.comoAdmin(() =>
      h.fila<{ processing_state: string; temperature_state: string; quantity: string }>(
        "select processing_state::text, temperature_state::text, quantity::text from public.inventory_lots where id = $1",
        [sobra],
      ),
    );
    expect(l!.processing_state).toBe("COOKED");
    expect(l!.temperature_state).toBe("CHILLED"); // nació en el refrigerador
    expect(Number(l!.quantity)).toBe(200);

    // §48: etiqueta de sobra, con el snapshot correcto.
    const job = await h.como(USER_A, async () =>
      (await h.fila<{ create_label_job: string }>("select public.create_label_job($1)", [sobra]))!
        .create_label_job,
    );
    const snap = await h.como(USER_A, () =>
      h.fila<{ snapshot: unknown }>("select snapshot from public.label_print_jobs where id = $1", [job]),
    );
    const parsed = labelSnapshotSchema.parse(snap!.snapshot);
    expect(parsed.processing_state).toBe("COOKED");
    const pdf = await generateLabelsPdf([parsed], "https://mesa.familia");
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
