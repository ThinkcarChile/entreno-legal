"use server";

import { revalidatePath } from "next/cache";

import { EvidenceType } from "@/lib/domain/enums";
import {
  buildEvidencePath,
  EVIDENCE_BUCKET,
  inspectUploadedEvidence,
  isGeneratedEvidencePath,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Antes de subir un archivo de evidencia: valida tipo y tamaño declarados y
 * devuelve dónde subirlo. La ruta la genera el servidor; el navegador sube ahí
 * directo a Storage, con su sesión, y la política del bucket decide si puede.
 */
export async function prepareJobEvidenceUploadAction(
  assignmentId: string,
  file: { type: string; size: number },
): Promise<ActionResult<{ bucket: string; path: string }>> {
  try {
    const { userId } = await requireSession();
    if (!UUID.test(assignmentId)) return { ok: false, error: "Ese trabajo no existe." };

    const check = validateEvidence({ type: String(file?.type ?? ""), size: Number(file?.size ?? 0) });
    if (!check.ok) return { ok: false, error: check.message!, field: "file" };

    return actionOk({ bucket: EVIDENCE_BUCKET, path: buildEvidencePath(userId, assignmentId, file.type) });
  } catch (error) {
    return actionError(error, "No pudimos preparar la subida del archivo.");
  }
}

/**
 * Actualización del trabajo, con o sin archivo.
 *
 * El archivo ya no viaja aquí: el navegador lo subió directo a Storage, en la
 * ruta que dio `prepareJobEvidenceUploadAction`, y aquí llega solo esa ruta
 * (`storagePath`). Antes de registrar se descarga con la sesión de quien lo
 * subió y se miran sus primeros bytes: el tipo y el tamaño que se registran son
 * los medidos, no los declarados. Si algo no cuadra, el archivo se retira.
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
    const uploadedPath = String(form.get("storagePath") ?? "").trim() || null;
    // La ruta llega del navegador: solo vale la forma exacta que generó
    // `prepare…UploadAction` para esta persona y este ámbito. Una ruta ajena ni
    // se inspecciona ni se borra.
    if (uploadedPath && !isGeneratedEvidencePath(uploadedPath, userId, assignmentId)) {
      return { ok: false, error: "Esa ruta de archivo no es válida.", field: "file" };
    }
    const bucket = supabase.storage.from(EVIDENCE_BUCKET);

    // Si la publicación no se registra, el archivo subido no puede quedar
    // huérfano: se retira con la sesión de quien lo subió
    // (`evidence_own_delete_unregistered` lo permite mientras no esté registrado).
    const discard = async () => {
      if (uploadedPath) await bucket.remove([uploadedPath]);
    };

    if (form.get("file") instanceof File && (form.get("file") as File).size > 0) {
      return { ok: false, error: "Recarga la página e inténtalo de nuevo.", field: "file" };
    }
    if (!title) {
      await discard();
      return { ok: false, error: "Escribe un título para la actualización.", field: "title" };
    }
    if (title.length > 120) {
      await discard();
      return { ok: false, error: "El título es demasiado largo.", field: "title" };
    }
    if (!["NOTE", "PHOTO", "QUEUE_STATUS", "LOCATION"].includes(type)) {
      await discard();
      return { ok: false, error: "Ese tipo de actualización no existe." };
    }

    let storagePath: string | null = null;
    let mimeType: string | null = null;
    let sizeBytes: number | null = null;

    if (uploadedPath) {
      const inspected = await inspectUploadedEvidence((path) => bucket.download(path), uploadedPath);
      if (!inspected.ok) {
        await discard();
        return { ok: false, error: inspected.message, field: "file" };
      }
      storagePath = uploadedPath;
      mimeType = inspected.type;
      sizeBytes = inspected.size;
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
      await discard();
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
