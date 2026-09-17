"use server";

import { revalidatePath } from "next/cache";

import { getPricingEngine } from "@/lib/pricing";
import { timezoneFor } from "@/lib/geo/chile";
import { zonedInputToUtc } from "@/lib/utils/datetime";
import { actionError, actionOk, type ActionResult } from "@/lib/utils/errors";
import { publishJobSchema } from "@/lib/validation/job";

import { requireSession } from "./guards";

/**
 * Publicación y edición de trabajos.
 *
 * El rango sugerido se calcula en el servidor, no se acepta el que venga del
 * navegador: queda guardado como referencia de auditoría de precios.
 */

export async function publishJobAction(input: unknown): Promise<ActionResult<{ jobId: string }>> {
  const parsed = publishJobSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue.message, field: String(issue.path[0] ?? "") };
  }

  const draft = parsed.data;

  try {
    const { supabase } = await requireSession();

    const { data: category, error: categoryError } = await supabase
      .from("job_categories")
      .select("id,category_group,base_hourly_min,base_hourly_max")
      .eq("id", draft.categoryId)
      .maybeSingle<{
        id: string;
        category_group: string;
        base_hourly_min: number;
        base_hourly_max: number;
      }>();

    if (categoryError || !category) {
      return { ok: false, error: "La categoría elegida ya no está disponible.", field: "categoryId" };
    }

    const timezone = timezoneFor(draft.regionCode, draft.communeCode);
    const startsAt = zonedInputToUtc(draft.date, draft.time, timezone);

    if (startsAt.getTime() < Date.now() - 60 * 60 * 1000) {
      return { ok: false, error: "La fecha y hora deben estar en el futuro.", field: "date" };
    }

    const suggestion = getPricingEngine().suggest({
      categoryGroup: category.category_group as "FILA" | "TRAMITE",
      categoryId: category.id,
      categoryBase: { min: category.base_hourly_min, max: category.base_hourly_max },
      regionCode: draft.regionCode,
      communeCode: draft.communeCode,
      startsAt: startsAt.toISOString(),
      durationMinutes: draft.durationMinutes,
      urgency: draft.urgency,
      timezone,
    });

    const { data, error } = await supabase.rpc("publish_job", {
      p_payload: {
        categoryId: draft.categoryId,
        status: "PUBLISHED",
        title: draft.title,
        description: draft.description,
        instructions: draft.instructions || null,
        regionCode: draft.regionCode,
        communeCode: draft.communeCode,
        placeName: draft.placeName || null,
        addressLine: draft.addressLine,
        addressNotes: draft.addressNotes || null,
        lat: draft.lat ?? null,
        lng: draft.lng ?? null,
        startsAt: startsAt.toISOString(),
        estimatedDurationMinutes: draft.durationMinutes,
        urgency: draft.urgency,
        objectiveType: draft.objectiveType,
        targetPosition: draft.targetPosition ?? null,
        objectiveDescription: draft.objectiveDescription || null,
        bonusAmount: draft.bonusAmount ?? null,
        bonusConditions: draft.bonusConditions || null,
        hourlyRate: draft.hourlyRate,
        suggestedHourlyMin: suggestion.hourlyMin.amount,
        suggestedHourlyMax: suggestion.hourlyMax.amount,
      },
    });

    if (error) return actionError(error, "No pudimos publicar el trabajo.");

    revalidatePath("/trabajos");
    revalidatePath("/mis-trabajos/publicados");
    return actionOk({ jobId: String(data) });
  } catch (error) {
    return actionError(error, "No pudimos publicar el trabajo.");
  }
}

export interface UpdateJobInput {
  jobId: string;
  title?: string;
  description?: string;
  instructions?: string | null;
  placeName?: string | null;
  addressLine?: string;
  addressNotes?: string | null;
  date?: string;
  time?: string;
  durationMinutes?: number;
  hourlyRate?: number;
  bonusAmount?: number | null;
  bonusConditions?: string | null;
}

export async function updateJobAction(input: UpdateJobInput): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();

    const { data: job } = await supabase
      .from("jobs")
      .select("region_code,commune_code,timezone,starts_at")
      .eq("id", input.jobId)
      .maybeSingle<{
        region_code: string;
        commune_code: string;
        timezone: string;
        starts_at: string;
      }>();

    if (!job) return { ok: false, error: "No encontramos el trabajo." };

    const payload: Record<string, unknown> = {};
    if (input.title) payload.title = input.title;
    if (input.description) payload.description = input.description;
    if (input.instructions !== undefined) payload.instructions = input.instructions ?? "";
    if (input.placeName !== undefined) payload.placeName = input.placeName ?? "";
    if (input.addressLine !== undefined) payload.addressLine = input.addressLine;
    if (input.addressNotes !== undefined) payload.addressNotes = input.addressNotes ?? "";
    if (input.durationMinutes) payload.estimatedDurationMinutes = String(input.durationMinutes);
    if (input.hourlyRate) payload.hourlyRate = String(input.hourlyRate);
    if (input.bonusAmount !== undefined) {
      payload.bonusAmount = input.bonusAmount ? String(input.bonusAmount) : "";
    }
    if (input.bonusConditions !== undefined) payload.bonusConditions = input.bonusConditions ?? "";

    if (input.date && input.time) {
      payload.startsAt = zonedInputToUtc(input.date, input.time, job.timezone).toISOString();
    }

    const { error } = await supabase.rpc("update_open_job", {
      p_job_id: input.jobId,
      p_payload: payload,
    });

    if (error) return actionError(error, "No pudimos guardar los cambios.");

    revalidatePath(`/trabajos/${input.jobId}`);
    revalidatePath("/mis-trabajos/publicados");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos guardar los cambios.");
  }
}

export async function cancelJobAction(jobId: string, reason?: string): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("cancel_job", { p_job_id: jobId, p_reason: reason ?? null });

    if (error) return actionError(error, "No pudimos cancelar el trabajo.");

    revalidatePath("/mis-trabajos/publicados");
    revalidatePath("/trabajos");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos cancelar el trabajo.");
  }
}
