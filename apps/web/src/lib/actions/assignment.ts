"use server";

import { revalidatePath } from "next/cache";

import { EvidenceType } from "@/lib/domain/enums";
import {
  buildEvidencePath,
  EVIDENCE_BUCKET,
  isOwnEvidencePath,
  validateEvidence,
} from "@/lib/storage/evidence";
import { createAdminClient } from "@/lib/supabase/admin";
import { actionError, actionOk, type ActionResult } from "@/lib/utils/errors";

import { requireSession } from "./guards";

/**
 * Ejecución del trabajo asignado.
 *
 * Cada acción es una llamada a una función de la base que comprueba quién
 * llama, en qué estado está el trabajo y bloquea `jobs → assignments` antes de
 * decidir. Aquí no hay lógica de negocio: hay validación de formato, traducción
 * de errores y refresco de la pantalla.
 *
 * Antes de la Etapa 3 esto era un `UPDATE` directo sobre `assignments` con la
 * hora del navegador. Ese privilegio ya no existe.
 */

function refresh(assignmentId: string): void {
  revalidatePath(`/mis-trabajos/${assignmentId}`);
  revalidatePath("/mis-trabajos");
  revalidatePath("/mis-trabajos/publicados");
}

/* ------------------------------------------------------------ trabajador */

/** «Voy en camino». Repetirla no duplica el aviso. */
export async function markOnTheWayAction(assignmentId: string): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("mark_on_the_way", { p_assignment_id: assignmentId });
    if (error) return actionError(error, "No pudimos avisar que vas en camino.");
    refresh(assignmentId);
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos avisar que vas en camino.");
  }
}

export interface CheckInOutcome {
  result: string;
  reviewStatus: string;
  distanceM: number | null;
  canStart: boolean;
}

/**
 * Check-in con consentimiento explícito.
 *
 * La ubicación llega desde el navegador porque es el único que puede pedirla,
 * pero no decide nada: la distancia la calcula la base contra la dirección real
 * del trabajo, y la hora es la del servidor. Sin ubicación el check-in se
 * registra igual, como declarado, y queda esperando revisión.
 */
export async function registerCheckInAction(
  assignmentId: string,
  input: {
    consent: boolean;
    lat?: number | null;
    lng?: number | null;
    accuracyM?: number | null;
    source?: "device" | "manual";
  },
): Promise<ActionResult<CheckInOutcome>> {
  try {
    if (!input.consent) {
      return { ok: false, error: "Necesitamos tu permiso para registrar la llegada." };
    }

    const { supabase } = await requireSession();
    const { data, error } = await supabase.rpc("register_check_in", {
      p_assignment_id: assignmentId,
      p_consent: true,
      p_lat: Number.isFinite(input.lat) ? input.lat : null,
      p_lng: Number.isFinite(input.lng) ? input.lng : null,
      p_accuracy_m:
        input.accuracyM != null && Number.isFinite(input.accuracyM)
          ? Math.round(input.accuracyM)
          : null,
      p_source: input.source ?? "device",
    });

    if (error) return actionError(error, "No pudimos registrar tu llegada.");

    const row = (data ?? {}) as Record<string, unknown>;
    refresh(assignmentId);
    return actionOk({
      result: String(row.result ?? "NO_LOCATION"),
      reviewStatus: String(row.review_status ?? "PENDING"),
      distanceM: row.distance_m == null ? null : Number(row.distance_m),
      canStart: row.can_start === true,
    });
  } catch (error) {
    return actionError(error, "No pudimos registrar tu llegada.");
  }
}

export async function startWorkAction(assignmentId: string): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("start_job_work", { p_assignment_id: assignmentId });
    if (error) return actionError(error, "No pudimos comenzar el trabajo.");
    refresh(assignmentId);
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos comenzar el trabajo.");
  }
}

/**
 * Actualización del trabajo, con o sin archivo.
 *
 * El archivo viaja al servidor, se valida por contenido y se sube con la sesión
 * de quien lo manda: así la política de Storage sigue aplicando y la carpeta no
 * puede ser la de otro. Recién después se registra la fila, por RPC.
 */
export async function addJobEvidenceAction(
  assignmentId: string,
  form: FormData,
): Promise<ActionResult<{ id: string }>> {
  try {
    const { supabase, userId } = await requireSession();

    const type = String(form.get("evidenceType") ?? EvidenceType.NOTE);
    const title = String(form.get("title") ?? "").trim();
    const body = String(form.get("body") ?? "").trim();
    const queueAheadRaw = String(form.get("queueAhead") ?? "").trim();
    const file = form.get("file");

    if (!title) return { ok: false, error: "Escribe un título para la actualización.", field: "title" };
    if (title.length > 120) {
      return { ok: false, error: "El título es demasiado largo.", field: "title" };
    }
    if (!["NOTE", "PHOTO", "QUEUE_STATUS", "LOCATION"].includes(type)) {
      return { ok: false, error: "Ese tipo de actualización no existe." };
    }

    let storagePath: string | null = null;
    let mimeType: string | null = null;
    let sizeBytes: number | null = null;

    if (file instanceof File && file.size > 0) {
      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const check = validateEvidence({ type: file.type, size: file.size }, head);
      if (!check.ok) return { ok: false, error: check.message!, field: "file" };

      storagePath = buildEvidencePath(userId, assignmentId, file.type);
      if (!isOwnEvidencePath(storagePath, userId)) {
        return { ok: false, error: "No pudimos preparar la ruta del archivo." };
      }

      const upload = await supabase.storage
        .from(EVIDENCE_BUCKET)
        .upload(storagePath, file, { contentType: file.type, upsert: false });

      if (upload.error) return actionError(upload.error, "No pudimos guardar el archivo.");

      mimeType = file.type;
      sizeBytes = file.size;
    }

    const { data, error } = await supabase.rpc("add_job_evidence", {
      p_assignment_id: assignmentId,
      p_evidence_type: type,
      p_title: title,
      p_body: body || null,
      p_storage_path: storagePath,
      p_mime_type: mimeType,
      p_size_bytes: sizeBytes,
      p_queue_ahead: queueAheadRaw ? Number(queueAheadRaw) : null,
    });

    if (error) {
      // Si la fila no se pudo registrar, el archivo subido queda huérfano: se
      // retira para no dejar basura en un bucket privado.
      if (storagePath) await supabase.storage.from(EVIDENCE_BUCKET).remove([storagePath]);
      return actionError(error, "No pudimos publicar la actualización.");
    }

    refresh(assignmentId);
    return actionOk({ id: String(data) });
  } catch (error) {
    return actionError(error, "No pudimos publicar la actualización.");
  }
}

/**
 * URL firmada para ver un archivo de evidencia.
 *
 * Dura un minuto y se emite solo si quien pregunta puede leer la fila con SU
 * sesión: la comprobación es la RLS de `job_evidence`, no una condición escrita
 * aquí. La firma se hace con la clave de servicio porque el bucket es privado.
 */
export async function getEvidenceUrlAction(
  evidenceId: string,
): Promise<ActionResult<{ url: string }>> {
  try {
    const { supabase } = await requireSession();

    const { data: row, error } = await supabase
      .from("job_evidence")
      .select("storage_path")
      .eq("id", evidenceId)
      .maybeSingle<{ storage_path: string | null }>();

    if (error) return actionError(error, "No pudimos abrir el archivo.");
    if (!row?.storage_path) return { ok: false, error: "Esa evidencia no tiene archivo." };

    const admin = createAdminClient();
    const signed = await admin.storage.from(EVIDENCE_BUCKET).createSignedUrl(row.storage_path, 60);

    if (signed.error || !signed.data) {
      return actionError(signed.error, "No pudimos abrir el archivo.");
    }
    return actionOk({ url: signed.data.signedUrl });
  } catch (error) {
    return actionError(error, "No pudimos abrir el archivo.");
  }
}

/* ------------------------------------------------------------ extensiones */

export async function requestExtensionAction(
  assignmentId: string,
  minutes: number,
  reason?: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    const { supabase } = await requireSession();
    const { data, error } = await supabase.rpc("request_job_extension", {
      p_assignment_id: assignmentId,
      p_minutes: Math.round(minutes),
      p_reason: reason?.trim() || null,
    });
    if (error) return actionError(error, "No pudimos pedir más tiempo.");
    refresh(assignmentId);
    return actionOk({ id: String(data) });
  } catch (error) {
    return actionError(error, "No pudimos pedir más tiempo.");
  }
}

export async function answerExtensionAction(
  assignmentId: string,
  extensionId: string,
  accept: boolean,
): Promise<ActionResult<{ status: string; paymentId: string | null }>> {
  try {
    const { supabase } = await requireSession();
    const { data, error } = await supabase.rpc("answer_job_extension", {
      p_extension_id: extensionId,
      p_accept: accept,
    });
    if (error) return actionError(error, "No pudimos responder la solicitud.");
    const row = (data ?? {}) as Record<string, unknown>;
    refresh(assignmentId);
    return actionOk({
      status: String(row.status ?? ""),
      paymentId: (row.payment_id as string | null) ?? null,
    });
  } catch (error) {
    return actionError(error, "No pudimos responder la solicitud.");
  }
}

/* --------------------------------------------------------- código de entrega */

export async function generateHandoffCodeAction(
  assignmentId: string,
): Promise<ActionResult<{ code: string }>> {
  try {
    const { supabase } = await requireSession();
    const { data, error } = await supabase.rpc("generate_handoff_code", {
      p_assignment_id: assignmentId,
    });
    if (error) return actionError(error, "No pudimos generar el código de entrega.");
    refresh(assignmentId);
    return actionOk({ code: String(data) });
  } catch (error) {
    return actionError(error, "No pudimos generar el código de entrega.");
  }
}

/** Solo el cliente. El código nunca sale por otra vía. */
export async function getHandoffCodeAction(assignmentId: string): Promise<
  ActionResult<{
    exists: boolean;
    code: string | null;
    verified: boolean;
    expired: boolean;
    attempts: number;
  }>
> {
  try {
    const { supabase } = await requireSession();
    const { data, error } = await supabase.rpc("get_handoff_code", {
      p_assignment_id: assignmentId,
    });
    if (error) return actionError(error, "No pudimos recuperar el código de entrega.");
    const row = (data ?? {}) as Record<string, unknown>;
    return actionOk({
      exists: row.exists === true,
      code: (row.code as string | null) ?? null,
      verified: row.verified === true,
      expired: row.expired === true,
      attempts: Number(row.attempts ?? 0),
    });
  } catch (error) {
    return actionError(error, "No pudimos recuperar el código de entrega.");
  }
}

export async function requestHandoffCodeAction(
  assignmentId: string,
): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("request_handoff_code", {
      p_assignment_id: assignmentId,
    });
    if (error) return actionError(error, "No pudimos avisar al cliente.");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos avisar al cliente.");
  }
}

export async function verifyHandoffCodeAction(
  assignmentId: string,
  code: string,
): Promise<ActionResult<{ verified: boolean }>> {
  try {
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 4) {
      return { ok: false, error: "El código tiene cuatro dígitos.", field: "code" };
    }

    const { supabase } = await requireSession();
    const { data, error } = await supabase.rpc("verify_handoff_code", {
      p_assignment_id: assignmentId,
      p_code: clean,
    });
    if (error) return actionError(error, "No pudimos validar el código.");

    refresh(assignmentId);
    if (data !== true) {
      return { ok: false, error: "Ese código no corresponde. Revísalo con el cliente.", field: "code" };
    }
    return actionOk({ verified: true });
  } catch (error) {
    return actionError(error, "No pudimos validar el código.");
  }
}

/* -------------------------------------------------------------- cierre */

export async function requestCompletionAction(
  assignmentId: string,
  note?: string,
): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("request_job_completion", {
      p_assignment_id: assignmentId,
      p_note: note?.trim() || null,
    });
    if (error) return actionError(error, "No pudimos cerrar el trabajo.");
    refresh(assignmentId);
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos cerrar el trabajo.");
  }
}

/** La aprobación del cliente es lo único que libera el pago al trabajador. */
export async function approveCompletionAction(
  assignmentId: string,
  bonusAwarded = true,
): Promise<ActionResult<{ payoutStatus: string | null }>> {
  try {
    const { supabase } = await requireSession();
    const { data, error } = await supabase.rpc("approve_job_completion", {
      p_assignment_id: assignmentId,
      p_bonus_awarded: bonusAwarded,
    });
    if (error) return actionError(error, "No pudimos aprobar el trabajo.");
    const row = (data ?? {}) as Record<string, unknown>;
    refresh(assignmentId);
    return actionOk({ payoutStatus: (row.payout_status as string | null) ?? null });
  } catch (error) {
    return actionError(error, "No pudimos aprobar el trabajo.");
  }
}

export async function submitReviewAction(
  assignmentId: string,
  input: {
    overall: number;
    punctuality: number;
    communication: number;
    compliance: number;
    comment?: string;
  },
): Promise<ActionResult<{ id: string }>> {
  try {
    const scores = [input.overall, input.punctuality, input.communication, input.compliance];
    if (scores.some((s) => !Number.isInteger(s) || s < 1 || s > 5)) {
      return { ok: false, error: "Las puntuaciones van de 1 a 5." };
    }

    const { supabase } = await requireSession();
    const { data, error } = await supabase.rpc("submit_review", {
      p_assignment_id: assignmentId,
      p_overall: input.overall,
      p_punctuality: input.punctuality,
      p_communication: input.communication,
      p_compliance: input.compliance,
      p_comment: input.comment?.trim() || null,
    });
    if (error) return actionError(error, "No pudimos guardar tu reseña.");
    refresh(assignmentId);
    return actionOk({ id: String(data) });
  } catch (error) {
    return actionError(error, "No pudimos guardar tu reseña.");
  }
}
