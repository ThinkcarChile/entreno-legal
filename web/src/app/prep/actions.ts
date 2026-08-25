"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { effectiveDate } from "@/domain/nutrition/calendar";
import { planPrep } from "@/domain/prep/engine";
import type { DraftTask, SuggestedPackage } from "@/domain/prep/types";
import { loadPrepInput } from "./queries";
import { DataAccessError } from "@/lib/supabase/unwrap";

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  planId?: string;
  jobIds?: string[];
}

async function contexto(): Promise<
  | { ok: true; supabase: Awaited<ReturnType<typeof createSupabaseServer>>; householdId: string; memberIds: string[]; tz: string }
  | { ok: false; error: string }
> {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/prep");
  const { householdId, members } = await loadHouseholdMembers(supabase);
  if (!householdId) return { ok: false, error: "Primero crea o únete a un hogar." };
  const { data: hogar, error } = await supabase
    .from("households")
    .select("timezone")
    .eq("id", householdId)
    .maybeSingle();
  if (error) throw new DataAccessError("zona horaria del hogar", error);
  return {
    ok: true,
    supabase,
    householdId,
    memberIds: members.map((m) => m.id),
    tz: hogar?.timezone ?? "America/Santiago",
  };
}

function refrescar() {
  revalidatePath("/prep");
  revalidatePath("/pantry");
}

/**
 * Generar el plan (§17): calcula con el motor determinista y lo GUARDA como
 * sugerencia. El ledger no se toca — eso pasa recién al confirmar cada tarea.
 * Idempotente por día (dedupe): regenerar el mismo día reutiliza el plan vivo.
 */
export async function generatePrepPlan(): Promise<ActionResult> {
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const hoy = effectiveDate(new Date(), ctx.tz);

  const input = await loadPrepInput(ctx.supabase, ctx.householdId, ctx.memberIds, hoy, ctx.tz);
  const draft = planPrep(input);
  if (draft.tasks.length === 0) {
    return {
      ok: false,
      error:
        "Nada que preparar: no hay demanda confirmada en los próximos 7 días para el stock disponible (no se inventan porciones).",
    };
  }

  const tareas = draft.tasks.map((t: DraftTask) => ({
    block_label: t.blockLabel,
    task_type: t.taskType,
    lot_id: t.lotId,
    ingredient_id: t.ingredientId,
    label: t.label,
    planned_quantity: t.plannedQuantity,
    unit: t.unit,
    params: t.params,
    depends_on_index: t.dependsOnIndex,
  }));

  const { data, error } = await ctx.supabase.rpc("save_prep_plan", {
    p_household_id: ctx.householdId,
    p_plan_date: hoy,
    p_engine_version: draft.engineVersion,
    p_complexity: draft.complexity,
    p_summary: {
      ...draft.summary,
      leave_whole: draft.leaveWhole,
      thaw_suggestions: draft.thawSuggestions,
      warnings: draft.warnings,
    },
    p_dedupe_key: `PREP:${ctx.householdId}:${hoy}`,
    p_tasks: tareas,
  });
  if (error) return { ok: false, error: `No se pudo guardar el plan: ${error.message}` };

  refrescar();
  return {
    ok: true,
    planId: typeof data === "string" ? data : undefined,
    message: `Plan listo: ${draft.summary.totalTasks} tareas, ~${draft.summary.estimatedMinutes} min.`,
  };
}

/**
 * Confirmación FÍSICA (§17-§18): la cantidad real de la persona manda.
 * El RPC es idempotente: dos personas confirmando la misma tarea = UNA
 * transformación (§60, §82).
 */
export async function completeTask(input: {
  taskId: string;
  actualQuantity?: number | null;
  outputs?: {
    output_quantity?: number;
    waste_quantity?: number;
    waste_cause?: string;
    packages?: {
      quantity: number;
      location_id?: string | null;
      vacuum?: boolean;
      intended_use_date?: string | null;
      intended_assignment_id?: string | null;
    }[];
    location_id?: string | null;
  } | null;
}): Promise<ActionResult> {
  if (input.actualQuantity != null && (!Number.isFinite(input.actualQuantity) || input.actualQuantity < 0)) {
    return { ok: false, error: "La cantidad real tiene que ser un número positivo." };
  }
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { error } = await ctx.supabase.rpc("complete_prep_task", {
    p_task_id: input.taskId,
    p_actual_quantity: input.actualQuantity ?? null,
    p_outputs: input.outputs ?? null,
  });
  if (error) return { ok: false, error: error.message };
  refrescar();
  return { ok: true, message: "Listo: registrado en la despensa." };
}

export async function skipTask(taskId: string): Promise<ActionResult> {
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { error } = await ctx.supabase.rpc("skip_prep_task", { p_task_id: taskId });
  if (error) return { ok: false, error: error.message };
  refrescar();
  return { ok: true, message: "Tarea saltada (sin tocar la despensa)." };
}

export async function cancelPlan(planId: string): Promise<ActionResult> {
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { error } = await ctx.supabase.rpc("cancel_prep_plan", { p_plan_id: planId });
  if (error) return { ok: false, error: error.message };
  refrescar();
  return { ok: true, message: "Plan cancelado. Lo ya hecho queda hecho (§81)." };
}

/** Etiquetas para los paquetes creados por una tarea PORTION completada. */
export async function createLabelsForTask(taskId: string): Promise<ActionResult> {
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { data, error } = await ctx.supabase
    .from("batch_prep_tasks")
    .select("result, status")
    .eq("id", taskId)
    .maybeSingle();
  if (error) return { ok: false, error: "No se pudo leer la tarea." };
  if (!data || data.status !== "DONE") {
    return { ok: false, error: "Primero completa la tarea: las etiquetas son de paquetes REALES." };
  }
  const ids = ((data.result as { child_lot_ids?: string[] })?.child_lot_ids ?? []).concat(
    (data.result as { lot_id?: string })?.lot_id ? [(data.result as { lot_id: string }).lot_id] : [],
  );
  if (ids.length === 0) return { ok: false, error: "Esta tarea no creó paquetes que etiquetar." };

  const jobs: string[] = [];
  for (const lotId of ids) {
    const { data: job, error: jobError } = await ctx.supabase.rpc("create_label_job", {
      p_lot_id: lotId,
    });
    if (jobError) return { ok: false, error: jobError.message };
    if (typeof job === "string") jobs.push(job);
  }
  refrescar();
  return { ok: true, jobIds: jobs, message: `${jobs.length} etiqueta(s) generadas.` };
}

/** Reimprimir (§39/§79): nuevo print job del MISMO lote, jamás un lote nuevo. */
export async function reprintLabel(lotId: string): Promise<ActionResult> {
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { data, error } = await ctx.supabase.rpc("create_label_job", { p_lot_id: lotId });
  if (error) return { ok: false, error: error.message };
  return { ok: true, jobIds: typeof data === "string" ? [data] : [], message: "Etiqueta regenerada." };
}

export async function markLabelPrinted(jobId: string): Promise<ActionResult> {
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { error } = await ctx.supabase.rpc("mark_label_job", { p_job_id: jobId, p_status: "PRINTED" });
  if (error) return { ok: false, error: error.message };
  return { ok: true, message: "Marcada como impresa." };
}

// ---------------------------------------------------------------------------
// Equipamiento y preferencias (RLS directa)
// ---------------------------------------------------------------------------

export async function saveEquipment(input: {
  id?: string;
  name: string;
  notes: string | null;
  isActive: boolean;
}): Promise<ActionResult> {
  const nombre = input.name.trim();
  if (nombre.length === 0 || nombre.length > 120) {
    return { ok: false, error: "El nombre del equipo va de 1 a 120 caracteres." };
  }
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const fila = {
    household_id: ctx.householdId,
    name: nombre,
    notes: input.notes?.trim() || null,
    is_active: input.isActive,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = input.id
    ? await ctx.supabase.from("household_equipment").update(fila).eq("id", input.id).eq("household_id", ctx.householdId).select("id")
    : await ctx.supabase.from("household_equipment").insert(fila).select("id");
  if (error) {
    if (error.code === "23505") return { ok: false, error: "Ya existe un equipo con ese nombre." };
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) return { ok: false, error: "no autorizado" };
  revalidatePath("/prep/equipment");
  return { ok: true, message: `Equipo ${nombre} guardado.` };
}

export async function saveEquipmentConfig(input: {
  equipmentId: string;
  capability: string;
  sizeMm: number | null;
  maxBatchQuantity: number | null;
}): Promise<ActionResult> {
  const cap = input.capability.trim().toUpperCase().replace(/\s+/g, "_");
  if (cap.length === 0 || cap.length > 60) {
    return { ok: false, error: "La capacidad va de 1 a 60 caracteres." };
  }
  for (const [nombre, v] of [
    ["tamaño", input.sizeMm],
    ["capacidad por tanda", input.maxBatchQuantity],
  ] as const) {
    if (v !== null && (!Number.isFinite(v) || v <= 0)) {
      return { ok: false, error: `El ${nombre} tiene que ser un número mayor que cero.` };
    }
  }
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { data, error } = await ctx.supabase
    .from("household_equipment_configs")
    .insert({
      equipment_id: input.equipmentId,
      capability: cap,
      params: input.sizeMm != null ? { size_mm: input.sizeMm } : {},
      max_batch_quantity: input.maxBatchQuantity,
      max_batch_unit: input.maxBatchQuantity != null ? "G" : null,
    })
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "no autorizado" };
  revalidatePath("/prep/equipment");
  return { ok: true, message: "Configuración guardada." };
}

export async function savePrepPreference(input: {
  ingredientId: string;
  taskType: string;
  sizeMm: number | null;
  capabilityId: string | null;
  manualAlternative: string | null;
}): Promise<ActionResult> {
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { data, error } = await ctx.supabase
    .from("prep_preferences")
    .upsert(
      {
        household_id: ctx.householdId,
        ingredient_id: input.ingredientId,
        task_type: input.taskType,
        params: input.sizeMm != null ? { size_mm: input.sizeMm } : {},
        capability_id: input.capabilityId,
        manual_alternative: input.manualAlternative?.trim() || null,
        is_active: true,
      },
      { onConflict: "household_id,ingredient_id,task_type" },
    )
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "no autorizado" };
  revalidatePath("/prep/equipment");
  revalidatePath("/prep");
  return { ok: true, message: "Preferencia guardada." };
}

// ---------------------------------------------------------------------------
// Acciones rápidas del QR (§36) — todas por RPC existentes del ledger
// ---------------------------------------------------------------------------

export async function qrUseLot(lotId: string, quantity: number | null): Promise<ActionResult> {
  if (quantity != null && (!Number.isFinite(quantity) || quantity <= 0)) {
    return { ok: false, error: "La cantidad tiene que ser mayor que cero." };
  }
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { error } = await ctx.supabase.rpc("use_lot", { p_lot_id: lotId, p_quantity: quantity });
  if (error) return { ok: false, error: error.message };
  refrescar();
  return { ok: true, message: quantity == null ? "Lote usado completo." : `Usados ${quantity}.` };
}

export async function qrMoveLot(lotId: string, locationId: string): Promise<ActionResult> {
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { error } = await ctx.supabase.rpc("move_lot", { p_lot_id: lotId, p_location_id: locationId });
  if (error) return { ok: false, error: error.message };
  refrescar();
  return { ok: true, message: "Lote movido." };
}

export async function qrUpdateWeight(lotId: string, quantity: number): Promise<ActionResult> {
  if (!Number.isFinite(quantity) || quantity < 0) {
    return { ok: false, error: "La cantidad tiene que ser un número positivo." };
  }
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { error } = await ctx.supabase.rpc("adjust_lot", {
    p_lot_id: lotId,
    p_quantity: quantity,
    p_notes: "ajuste desde QR",
    p_approximate: false,
  });
  if (error) return { ok: false, error: error.message };
  refrescar();
  return { ok: true, message: "Peso actualizado." };
}

export async function qrDiscardLot(lotId: string, reason: "SPOILED" | "DISCARDED_LEFTOVER"): Promise<ActionResult> {
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { error } = await ctx.supabase.rpc("discard_lot", { p_lot_id: lotId, p_reason: reason });
  if (error) return { ok: false, error: error.message };
  refrescar();
  return { ok: true, message: "Merma registrada, con su causa." };
}

/** Rendimiento OBSERVADO (§45): se guarda la observación, jamás se pisa la referencia. */
export async function recordObservedYield(input: {
  ingredientId: string;
  cookingMethod: string | null;
  inputQuantity: number;
  outputQuantity: number;
  unit: "G" | "ML" | "UNIT";
  lotId: string | null;
}): Promise<ActionResult> {
  if (!Number.isFinite(input.inputQuantity) || input.inputQuantity <= 0) {
    return { ok: false, error: "La cantidad inicial tiene que ser mayor que cero." };
  }
  if (!Number.isFinite(input.outputQuantity) || input.outputQuantity < 0) {
    return { ok: false, error: "La cantidad final tiene que ser un número positivo." };
  }
  const ctx = await contexto();
  if (!ctx.ok) return ctx;
  const { error } = await ctx.supabase.from("household_observed_yields").insert({
    household_id: ctx.householdId,
    ingredient_id: input.ingredientId,
    cooking_method: input.cookingMethod,
    input_quantity: input.inputQuantity,
    output_quantity: input.outputQuantity,
    unit: input.unit,
    lot_id: input.lotId,
  });
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    message: `Observado: ${Math.round((input.outputQuantity / input.inputQuantity) * 100)}% de rendimiento (guardado como observación).`,
  };
}

export type { SuggestedPackage };
