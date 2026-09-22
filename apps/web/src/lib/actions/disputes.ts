"use server";

import { revalidatePath } from "next/cache";

import {
  buildEvidencePath,
  DISPUTE_BUCKET,
  isOwnEvidencePath,
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

/** Texto, archivo, o las dos cosas. Se valida el contenido real del archivo. */
export async function addDisputeEvidenceAction(
  assignmentId: string,
  disputeId: string,
  form: FormData,
): Promise<ActionResult<{ id: string }>> {
  try {
    const { supabase, userId } = await requireSession();

    const body = String(form.get("body") ?? "").trim();
    const file = form.get("file");
    const hasFile = file instanceof File && file.size > 0;

    if (!body && !hasFile) {
      return { ok: false, error: "Escribe algo o adjunta un archivo.", field: "body" };
    }
    if (body.length > 2000) {
      return { ok: false, error: "El texto es demasiado largo.", field: "body" };
    }

    let storagePath: string | null = null;
    let mimeType: string | null = null;
    let sizeBytes: number | null = null;

    if (hasFile) {
      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const check = validateEvidence({ type: file.type, size: file.size }, head);
      if (!check.ok) return { ok: false, error: check.message!, field: "file" };

      storagePath = buildEvidencePath(userId, disputeId, file.type);
      if (!isOwnEvidencePath(storagePath, userId)) {
        return { ok: false, error: "No pudimos preparar la ruta del archivo." };
      }

      const upload = await supabase.storage
        .from(DISPUTE_BUCKET)
        .upload(storagePath, file, { contentType: file.type, upsert: false });

      if (upload.error) return actionError(upload.error, "No pudimos guardar el archivo.");

      mimeType = file.type;
      sizeBytes = file.size;
    }

    const { data, error } = await supabase.rpc("add_dispute_evidence", {
      p_dispute_id: disputeId,
      p_body: body || null,
      p_storage_path: storagePath,
      p_mime_type: mimeType,
      p_size_bytes: sizeBytes,
    });

    if (error) {
      if (storagePath) await supabase.storage.from(DISPUTE_BUCKET).remove([storagePath]);
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
