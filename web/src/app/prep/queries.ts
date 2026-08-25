import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DataAccessError } from "@/lib/supabase/unwrap";
import {
  dateString,
  nullableNumeric,
  numeric,
  parseRows,
  uuid,
} from "@/lib/supabase/rows";
import { effectiveDate } from "@/domain/nutrition/calendar";
import type {
  EquipmentConfig,
  PrepDemand,
  PrepEngineInput,
  PrepLot,
  PrepPreference,
  SafetyRule,
} from "@/domain/prep/types";

type Db = SupabaseClient;

/**
 * Cargador del Sprint 10: todo lo que BatchPrepEngine y el SafetyEngine
 * necesitan, con Zod en el borde. Un error jamás se vuelve "no hay nada que
 * preparar" en silencio.
 */

const unitSchema = z.enum(["G", "ML", "UNIT"]);
const processingSchema = z.enum(["RAW", "PREPPED", "COOKED"]);
const temperatureSchema = z.enum(["AMBIENT", "CHILLED", "FROZEN"]);

const lotRow = z.object({
  id: uuid,
  ingredient_id: uuid.nullable(),
  label: z.string(),
  quantity: numeric,
  unit: unitSchema,
  processing_state: processingSchema,
  temperature_state: temperatureSchema,
  vacuum_sealed: z.boolean(),
  use_by: dateString.nullable(),
  expiry_date: dateString.nullable(),
  created_at: z.string(),
  intended_use_date: dateString.nullable(),
  ingredients: z
    .union([z.object({ category_id: uuid.nullable() }), z.array(z.object({ category_id: uuid.nullable() })), z.null()])
    .transform((v) => (Array.isArray(v) ? v[0] ?? null : v)),
  storage_locations: z
    .union([
      z.object({ kind: z.enum(["PANTRY", "FRIDGE", "FREEZER", "OTHER"]) }),
      z.array(z.object({ kind: z.enum(["PANTRY", "FRIDGE", "FREEZER", "OTHER"]) })),
      z.null(),
    ])
    .transform((v) => (Array.isArray(v) ? v[0] ?? null : v)),
});

const demandRow = z.object({
  assignment_id: uuid.nullable(),
  serving_date: dateString.nullable(),
  meal_type: z.string(),
  member_serving_components: z
    .union([
      z.array(
        z.object({
          ingredient_id: uuid.nullable(),
          proposed_quantity: numeric,
          unit: z.enum(["G", "ML"]),
        }),
      ),
      z.null(),
    ])
    .transform((v) => v ?? []),
});

const configRow = z.object({
  id: uuid,
  equipment_id: uuid,
  capability: z.string(),
  params: z.record(z.string(), z.unknown()).catch({}),
  max_batch_quantity: nullableNumeric,
  max_batch_unit: z.enum(["G", "ML", "UNIT"]).nullable(),
  is_active: z.boolean(),
  household_equipment: z
    .union([
      z.object({ name: z.string(), is_active: z.boolean() }),
      z.array(z.object({ name: z.string(), is_active: z.boolean() })),
      z.null(),
    ])
    .transform((v) => (Array.isArray(v) ? v[0] ?? null : v)),
});

const prefRow = z.object({
  ingredient_id: uuid,
  task_type: z.enum(["WASH", "PEEL", "TRIM", "CUT", "SHRED", "SLICE", "DICE", "PORTION", "PACK", "VACUUM_SEAL", "OTHER"]),
  params: z.record(z.string(), z.unknown()).catch({}),
  capability_id: uuid.nullable(),
  manual_alternative: z.string().nullable(),
  is_active: z.boolean(),
});

const ruleRow = z.object({
  id: uuid,
  household_id: uuid.nullable(),
  ingredient_id: uuid.nullable(),
  category_id: uuid.nullable(),
  processing_state: processingSchema.nullable(),
  temperature_state: temperatureSchema.nullable(),
  vacuum_sealed: z.boolean().nullable(),
  rule_kind: z.enum(["STORAGE_DAYS", "REFREEZE", "THAW"]),
  max_days: z.number().int().nullable(),
  use_soon_within_days: z.number().int(),
  refreeze_allowed: z.boolean().nullable(),
  thaw_fridge_hours: z.number().int().nullable(),
  source: z.string(),
});

export async function loadSafetyRules(db: Db, householdId: string): Promise<SafetyRule[]> {
  const { data, error } = await db
    .from("storage_safety_rules")
    .select(
      "id, household_id, ingredient_id, category_id, processing_state, temperature_state, vacuum_sealed, rule_kind, max_days, use_soon_within_days, refreeze_allowed, thaw_fridge_hours, source",
    )
    .eq("is_active", true)
    .or(`household_id.is.null,household_id.eq.${householdId}`);
  if (error) throw new DataAccessError("reglas de conservación", error);
  return parseRows(ruleRow, data, "reglas de conservación").map((r) => ({
    id: r.id,
    isHousehold: r.household_id != null,
    ingredientId: r.ingredient_id,
    categoryId: r.category_id,
    processingState: r.processing_state,
    temperatureState: r.temperature_state,
    vacuumSealed: r.vacuum_sealed,
    ruleKind: r.rule_kind,
    maxDays: r.max_days,
    useSoonWithinDays: r.use_soon_within_days,
    refreezeAllowed: r.refreeze_allowed,
    thawFridgeHours: r.thaw_fridge_hours,
    source: r.source,
  }));
}

export interface EquipmentView {
  id: string;
  name: string;
  notes: string | null;
  isActive: boolean;
  configs: EquipmentConfig[];
}

export async function loadEquipment(db: Db, householdId: string): Promise<EquipmentView[]> {
  const [equipos, configs] = await Promise.all([
    db
      .from("household_equipment")
      .select("id, name, notes, is_active")
      .eq("household_id", householdId)
      .order("name"),
    db
      .from("household_equipment_configs")
      .select(
        "id, equipment_id, capability, params, max_batch_quantity, max_batch_unit, is_active, household_equipment!inner ( name, is_active, household_id )",
      )
      .eq("household_equipment.household_id", householdId),
  ]);
  if (equipos.error) throw new DataAccessError("equipamiento", equipos.error);
  if (configs.error) throw new DataAccessError("configuraciones de equipo", configs.error);

  const parsed = parseRows(configRow, configs.data, "configuraciones de equipo").map(
    (c): EquipmentConfig => ({
      id: c.id,
      equipmentId: c.equipment_id,
      equipmentName: c.household_equipment?.name ?? "(equipo)",
      equipmentActive: c.household_equipment?.is_active ?? false,
      capability: c.capability,
      params: c.params,
      maxBatchQuantity: c.max_batch_quantity,
      maxBatchUnit: c.max_batch_unit,
      isActive: c.is_active,
    }),
  );

  return parseRows(
    z.object({ id: uuid, name: z.string(), notes: z.string().nullable(), is_active: z.boolean() }),
    equipos.data,
    "equipamiento",
  ).map((e) => ({
    id: e.id,
    name: e.name,
    notes: e.notes,
    isActive: e.is_active,
    configs: parsed.filter((c) => c.equipmentId === e.id),
  }));
}

export async function loadPrepPreferences(db: Db, householdId: string): Promise<PrepPreference[]> {
  const { data, error } = await db
    .from("prep_preferences")
    .select("ingredient_id, task_type, params, capability_id, manual_alternative, is_active")
    .eq("household_id", householdId)
    .eq("is_active", true);
  if (error) throw new DataAccessError("preferencias de preparación", error);
  return parseRows(prefRow, data, "preferencias de preparación").map((p) => ({
    ingredientId: p.ingredient_id,
    taskType: p.task_type,
    params: p.params,
    capabilityId: p.capability_id,
    manualAlternative: p.manual_alternative,
  }));
}

/** Todo lo que el motor necesita, en consultas agregadas fijas. */
export async function loadPrepInput(
  db: Db,
  householdId: string,
  memberIds: string[],
  today: string,
  timeZone: string,
): Promise<PrepEngineInput> {
  const [lotsRes, demandRes, prefs, equipment, rules, freezerRes] = await Promise.all([
    db
      .from("inventory_lots")
      .select(
        "id, ingredient_id, label, quantity, unit, processing_state, temperature_state, vacuum_sealed, use_by, expiry_date, created_at, intended_use_date, ingredients ( category_id ), storage_locations ( kind )",
      )
      .eq("household_id", householdId)
      .eq("status", "AVAILABLE")
      .gt("quantity", 0),
    db
      .from("member_serving_projections")
      .select(
        "assignment_id, serving_date, meal_type, member_serving_components ( ingredient_id, proposed_quantity, unit )",
      )
      .eq("status", "PLANNED")
      .gte("serving_date", today)
      .in("member_id", memberIds.length > 0 ? memberIds : ["00000000-0000-0000-0000-000000000000"]),
    loadPrepPreferences(db, householdId),
    loadEquipment(db, householdId),
    loadSafetyRules(db, householdId),
    db
      .from("storage_locations")
      .select("capacity_quantity, capacity_unit, kind")
      .eq("household_id", householdId)
      .eq("kind", "FREEZER"),
  ]);
  if (lotsRes.error) throw new DataAccessError("lotes", lotsRes.error);
  if (demandRes.error) throw new DataAccessError("porciones planificadas", demandRes.error);
  if (freezerRes.error) throw new DataAccessError("capacidad del congelador", freezerRes.error);

  const lots: PrepLot[] = parseRows(lotRow, lotsRes.data, "lotes")
    .filter((l) => l.ingredient_id !== null)
    .map((l) => ({
      id: l.id,
      ingredientId: l.ingredient_id!,
      categoryId: l.ingredients?.category_id ?? null,
      label: l.label,
      quantity: l.quantity,
      unit: l.unit,
      processingState: l.processing_state,
      temperatureState: l.temperature_state,
      vacuumSealed: l.vacuum_sealed,
      locationKind: l.storage_locations?.kind ?? null,
      useBy: l.use_by,
      expiryDate: l.expiry_date,
      createdOn: effectiveDate(new Date(l.created_at), timeZone),
      intendedUseDate: l.intended_use_date,
    }));

  const demand: PrepDemand[] = parseRows(demandRow, demandRes.data, "porciones planificadas")
    .filter((d) => d.assignment_id !== null && d.serving_date !== null)
    .flatMap((d) =>
      d.member_serving_components
        .filter((c) => c.ingredient_id !== null)
        .map((c) => ({
          assignmentId: d.assignment_id!,
          date: d.serving_date!,
          mealType: d.meal_type,
          ingredientId: c.ingredient_id!,
          quantity: c.proposed_quantity,
          unit: c.unit as "G" | "ML",
        })),
    );

  // §54: capacidad del congelador SOLO si el hogar la declaró en gramos.
  const freezers = parseRows(
    z.object({ capacity_quantity: nullableNumeric, capacity_unit: z.string().nullable() }).passthrough(),
    freezerRes.data,
    "capacidad del congelador",
  );
  const conCapacidad = freezers.filter((f) => f.capacity_quantity != null && f.capacity_unit === "G");
  const freezerCapacityKnown =
    conCapacidad.length > 0 && conCapacidad.length === freezers.length
      ? conCapacidad.reduce((acc, f) => acc + (f.capacity_quantity ?? 0), 0)
      : null;

  return {
    today,
    horizonDays: 7,
    lots,
    demand,
    preferences: prefs,
    capabilities: equipment.flatMap((e) => e.configs),
    safetyRules: rules,
    freezerCapacityKnown,
  };
}

// ---------------------------------------------------------------------------
// Planes guardados
// ---------------------------------------------------------------------------

const taskRow = z.object({
  id: uuid,
  seq: z.number().int(),
  block_label: z.string().nullable(),
  task_type: z.string(),
  lot_id: uuid.nullable(),
  ingredient_id: uuid.nullable(),
  label: z.string(),
  planned_quantity: nullableNumeric,
  unit: z.string().nullable(),
  params: z.record(z.string(), z.unknown()).catch({}),
  depends_on: uuid.nullable(),
  status: z.enum(["PENDING", "DONE", "SKIPPED", "CANCELLED"]),
  completed_quantity: nullableNumeric,
  completed_at: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).catch({}),
});

const planRow = z.object({
  id: uuid,
  plan_date: dateString,
  status: z.enum(["DRAFT", "READY", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
  engine_version: z.string().nullable(),
  complexity: z.number().int().nullable(),
  summary: z.record(z.string(), z.unknown()).catch({}),
  created_at: z.string(),
  batch_prep_tasks: z.union([z.array(taskRow), z.null()]).transform((v) => v ?? []),
});

export type PrepTaskView = z.infer<typeof taskRow>;
export type PrepPlanView = z.infer<typeof planRow>;

export async function loadPrepPlans(db: Db, householdId: string): Promise<PrepPlanView[]> {
  const { data, error } = await db
    .from("batch_prep_plans")
    .select(
      "id, plan_date, status, engine_version, complexity, summary, created_at, batch_prep_tasks ( id, seq, block_label, task_type, lot_id, ingredient_id, label, planned_quantity, unit, params, depends_on, status, completed_quantity, completed_at, result )",
    )
    .eq("household_id", householdId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new DataAccessError("planes de preparación", error);
  return parseRows(planRow, data, "planes de preparación").map((p) => ({
    ...p,
    batch_prep_tasks: [...p.batch_prep_tasks].sort((a, b) => a.seq - b.seq),
  }));
}

export async function loadPrepPlan(db: Db, planId: string): Promise<PrepPlanView | null> {
  const { data, error } = await db
    .from("batch_prep_plans")
    .select(
      "id, plan_date, status, engine_version, complexity, summary, created_at, batch_prep_tasks ( id, seq, block_label, task_type, lot_id, ingredient_id, label, planned_quantity, unit, params, depends_on, status, completed_quantity, completed_at, result )",
    )
    .eq("id", planId)
    .maybeSingle();
  if (error) throw new DataAccessError("plan de preparación", error);
  if (!data) return null;
  const parsed = planRow.parse(data);
  return { ...parsed, batch_prep_tasks: [...parsed.batch_prep_tasks].sort((a, b) => a.seq - b.seq) };
}
