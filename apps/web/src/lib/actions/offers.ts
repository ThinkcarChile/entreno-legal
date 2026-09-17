"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionError, actionOk, type ActionResult } from "@/lib/utils/errors";

import { requireSession } from "./guards";

/**
 * Ofertas.
 *
 * Aceptar pasa por `accept_job_offer`, que es atómica en la base: bloquea la
 * fila del trabajo y valida cliente, estado, elegibilidad y unicidad. Hacerlo
 * desde aquí con varias consultas dejaría una ventana para asignar dos
 * trabajadores al mismo trabajo.
 */

const offerSchema = z.object({
  jobId: z.string().uuid(),
  hourlyRate: z
    .number()
    .int("El monto debe ser un número entero en pesos")
    .min(3000, "La tarifa parece demasiado baja")
    .max(500_000, "La tarifa parece demasiado alta"),
  message: z.string().max(1000).optional().or(z.literal("")),
  arrivalMinutesBefore: z.number().int().min(0).max(720).default(15),
});

export async function sendOfferAction(input: unknown): Promise<ActionResult<{ offerId: string }>> {
  const parsed = offerSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue.message, field: String(issue.path[0] ?? "") };
  }

  try {
    const { supabase, userId } = await requireSession();

    const { data: job } = await supabase
      .from("jobs")
      .select("id,status,estimated_duration_minutes,starts_at,client_id")
      .eq("id", parsed.data.jobId)
      .maybeSingle<{
        id: string;
        status: string;
        estimated_duration_minutes: number;
        starts_at: string;
        client_id: string;
      }>();

    if (!job) return { ok: false, error: "No encontramos el trabajo." };
    if (job.status !== "PUBLISHED") {
      return { ok: false, error: "Este trabajo ya no está recibiendo ofertas." };
    }
    if (job.client_id === userId) {
      return { ok: false, error: "No puedes ofertar en tu propio trabajo." };
    }

    // El total se calcula aquí, desde la duración real del trabajo.
    const estimatedTotal = Math.round(
      (parsed.data.hourlyRate * job.estimated_duration_minutes) / 60,
    );
    const arrival = new Date(
      Date.parse(job.starts_at) - parsed.data.arrivalMinutesBefore * 60_000,
    ).toISOString();

    const { data, error } = await supabase
      .from("job_offers")
      .insert({
        job_id: parsed.data.jobId,
        worker_id: userId,
        hourly_rate: parsed.data.hourlyRate,
        estimated_total: estimatedTotal,
        message: parsed.data.message || null,
        estimated_arrival_at: arrival,
      })
      .select("id")
      .maybeSingle<{ id: string }>();

    if (error) {
      if (error.code === "23505") {
        return { ok: false, error: "Ya enviaste una oferta para este trabajo." };
      }
      if (error.code === "42501") {
        return {
          ok: false,
          error: "Necesitas tener tu identidad verificada para enviar ofertas.",
        };
      }
      return actionError(error, "No pudimos enviar tu oferta.");
    }

    revalidatePath(`/trabajos/${parsed.data.jobId}`);
    revalidatePath("/mis-trabajos");
    return actionOk({ offerId: data?.id ?? "" });
  } catch (error) {
    return actionError(error, "No pudimos enviar tu oferta.");
  }
}

/**
 * Editar una oferta pendiente.
 *
 * El precio no se puede cambiar: es inmutable por privilegio de columna y por
 * un trigger. Para cambiarlo, se retira la oferta y se envía otra, que además es
 * lo transparente de cara al cliente.
 */
export async function updateOfferAction(
  offerId: string,
  input: { message?: string; arrivalMinutesBefore?: number },
): Promise<ActionResult<void>> {
  try {
    const { supabase, userId } = await requireSession();

    const { data: offer } = await supabase
      .from("job_offers")
      .select("id,job_id,status,worker_id")
      .eq("id", offerId)
      .maybeSingle<{ id: string; job_id: string; status: string; worker_id: string }>();

    if (!offer || offer.worker_id !== userId) {
      return { ok: false, error: "No encontramos tu oferta." };
    }
    if (offer.status !== "PENDING") {
      return { ok: false, error: "Solo se puede editar una oferta pendiente." };
    }

    const patch: Record<string, unknown> = {};
    if (input.message !== undefined) patch.message = input.message || null;
    if (input.arrivalMinutesBefore !== undefined) {
      const { data: job } = await supabase
        .from("jobs")
        .select("starts_at")
        .eq("id", offer.job_id)
        .maybeSingle<{ starts_at: string }>();
      if (job) {
        patch.estimated_arrival_at = new Date(
          Date.parse(job.starts_at) - input.arrivalMinutesBefore * 60_000,
        ).toISOString();
      }
    }

    const { error } = await supabase.from("job_offers").update(patch).eq("id", offerId);
    if (error) return actionError(error, "No pudimos actualizar tu oferta.");

    revalidatePath(`/trabajos/${offer.job_id}`);
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos actualizar tu oferta.");
  }
}

export async function withdrawOfferAction(offerId: string): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("withdraw_job_offer", { p_offer_id: offerId });

    if (error) return actionError(error, "No pudimos retirar tu oferta.");

    revalidatePath("/mis-trabajos");
    revalidatePath("/trabajos");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos retirar tu oferta.");
  }
}

export async function acceptOfferAction(
  offerId: string,
): Promise<ActionResult<{ assignmentId: string }>> {
  try {
    const { supabase } = await requireSession();
    const { data, error } = await supabase.rpc("accept_job_offer", { p_offer_id: offerId });

    if (error) return actionError(error, "No pudimos aceptar la oferta.");

    revalidatePath("/mis-trabajos/publicados");
    revalidatePath("/trabajos");
    return actionOk({ assignmentId: String(data) });
  } catch (error) {
    return actionError(error, "No pudimos aceptar la oferta.");
  }
}
