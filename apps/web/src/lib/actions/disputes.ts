"use server";

import { revalidatePath } from "next/cache";

import {
  buildEvidencePath,
  DISPUTE_BUCKET,
  inspectUploadedEvidence,
  isGeneratedEvidencePath,
  validateEvidence,
} from "@/lib/storage/evidence";
import { createAdminClient } from "@/lib/supabase/admin";
import { actionError, actionOk, type ActionResult } from "@/lib/utils/errors";

import { requireSession } from "./guards";

/**
 * Disputas: abrir y aportar pruebas.
 *
 * Resolver es de la administración y vive en `admin.ts`. Aquí solo están las
 * dos acciones que corresponden a las partes.
 *
 * Abrir una disputa retiene el pago al trabajador —lo hace un disparador de la
 * base, no esta capa— y congela la aprobación del trabajo hasta que alguien
 * decida. Ninguna de las dos cosas devuelve dinero: eso necesita el proveedor
 * de pago integrado.
 */

export async function openDisputeAction(
  assignmentId: string,
  reason: string,
  description: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    const cleanReason = reason.trim();
    const cleanDescription = description.trim();

    if (!cleanReason) {
      return { ok: false, error: "Elige un motivo.", field: "reason" };
    }
    if (cleanDescription.length < 20) {
      return {
        ok: false,
        error: "Cuéntanos qué pasó con al menos 20 caracteres.",
        field: "description",
      };
    }
    if (cleanDescription.length > 2000) {
      return { ok: false, error: "La descripción es demasiado larga.", field: "description" };
    }

    const { supabase } = await requireSession();
    const { data, error } = await supabase.rpc("open_dispute", {
      p_assignment_id: assignmentId,
      p_reason: cleanReason,
      p_description: cleanDescription,
    });

    if (error) return actionError(error, "No pudimos abrir la disputa.");

    revalidatePath(`/mis-trabajos/${assignmentId}`);
    revalidatePath("/admin/disputas");
    return actionOk({ id: String(data) });
  } catch (error) {
    return actionError(error, "No pudimos abrir la disputa.");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Antes de subir una prueba con archivo: valida tipo y tamaño declarados y
 * devuelve dónde subirla. Igual que la evidencia del trabajo: la ruta la genera
 * el servidor y la subida la autoriza la política del bucket.
 */
export async function prepareDisputeEvidenceUploadAction(
  disputeId: string,
  file: { type: string; size: number },
): Promise<ActionResult<{ bucket: string; path: string }>> {
  try {
    const { userId } = await requireSession();
    if (!UUID.test(disputeId)) return { ok: false, error: "Esa disputa no existe." };

    const check = validateEvidence({ type: String(file?.type ?? ""), size: Number(file?.size ?? 0) });
    if (!check.ok) return { ok: false, error: check.message!, field: "file" };

    return actionOk({ bucket: DISPUTE_BUCKET, path: buildEvidencePath(userId, disputeId, file.type) });
  } catch (error) {
    return actionError(error, "No pudimos preparar la subida del archivo.");
  }
}

/**
 * Texto, archivo, o las dos cosas. El archivo ya está en Storage (lo subió el
 * navegador en la ruta de `prepareDisputeEvidenceUploadAction`); aquí llega su
 * ruta y se comprueba su contenido real antes de registrarlo.
 */
export async function addDisputeEvidenceAction(
  assignmentId: string,
  disputeId: string,
  form: FormData,
): Promise<ActionResult<{ id: string }>> {
  try {
    const { supabase, userId } = await requireSession();

    const body = String(form.get("body") ?? "").trim();
    const uploadedPath = String(form.get("storagePath") ?? "").trim() || null;
    // La ruta llega del navegador: solo vale la forma exacta que generó
    // `prepare…UploadAction` para esta persona y este ámbito. Una ruta ajena ni
    // se inspecciona ni se borra.
    if (uploadedPath && !isGeneratedEvidencePath(uploadedPath, userId, disputeId)) {
      return { ok: false, error: "Esa ruta de archivo no es válida.", field: "file" };
    }
    const bucket = supabase.storage.from(DISPUTE_BUCKET);

    // Mismo criterio que la evidencia del trabajo: lo que no se registra se
    // retira con la sesión de quien lo subió, mientras no esté registrado.
    const discard = async () => {
      if (uploadedPath) await bucket.remove([uploadedPath]);
    };

    if (form.get("file") instanceof File && (form.get("file") as File).size > 0) {
      return { ok: false, error: "Recarga la página e inténtalo de nuevo.", field: "file" };
    }
    if (!body && !uploadedPath) {
      return { ok: false, error: "Escribe algo o adjunta un archivo.", field: "body" };
    }
    if (body.length > 2000) {
      await discard();
      return { ok: false, error: "El texto es demasiado largo.", field: "body" };
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

    const { data, error } = await supabase.rpc("add_dispute_evidence", {
      p_dispute_id: disputeId,
      p_body: body || null,
      p_storage_path: storagePath,
      p_mime_type: mimeType,
      p_size_bytes: sizeBytes,
    });

    if (error) {
      await discard();
      return actionError(error, "No pudimos adjuntar la prueba.");
    }

    revalidatePath(`/mis-trabajos/${assignmentId}`);
    revalidatePath("/admin/disputas");
    return actionOk({ id: String(data) });
  } catch (error) {
    return actionError(error, "No pudimos adjuntar la prueba.");
  }
}

/** URL firmada corta para un archivo de disputa, solo si se puede leer la fila. */
export async function getDisputeFileUrlAction(
  evidenceId: string,
): Promise<ActionResult<{ url: string }>> {
  try {
    const { supabase } = await requireSession();

    const { data: row, error } = await supabase
      .from("dispute_evidence")
      .select("storage_path")
      .eq("id", evidenceId)
      .maybeSingle<{ storage_path: string | null }>();

    if (error) return actionError(error, "No pudimos abrir el archivo.");
    if (!row?.storage_path) return { ok: false, error: "Esa prueba no tiene archivo." };

    const admin = createAdminClient();
    const signed = await admin.storage.from(DISPUTE_BUCKET).createSignedUrl(row.storage_path, 60);

    if (signed.error || !signed.data) {
      return actionError(signed.error, "No pudimos abrir el archivo.");
    }
    return actionOk({ url: signed.data.signedUrl });
  } catch (error) {
    return actionError(error, "No pudimos abrir el archivo.");
  }
}
