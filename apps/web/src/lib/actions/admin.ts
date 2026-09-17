"use server";

import { revalidatePath } from "next/cache";

import { actionError, actionOk, type ActionResult } from "@/lib/utils/errors";

import { requireSession } from "./guards";

/**
 * Acciones del panel interno.
 *
 * Quién es administrador lo decide la base (`app_private.is_admin`), no esta
 * capa: la RPC vuelve a comprobarlo, así que esconder el enlace no es la
 * medida de seguridad, solo la de cortesía.
 *
 * Esta es la "simulación administrativa" de verificación pedida para la Etapa 2:
 * una persona del equipo aprueba o rechaza. El día que exista un proveedor
 * biométrico alimentará esta misma función.
 */
export async function reviewVerificationAction(
  verificationId: string,
  status: "VERIFIED" | "REJECTED" | "SUSPENDED",
  reason?: string,
): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("review_worker_verification", {
      p_verification_id: verificationId,
      p_status: status,
      p_reason: reason ?? null,
    });

    if (error) return actionError(error, "No pudimos resolver la verificación.");

    revalidatePath("/admin/verificaciones");
    revalidatePath("/admin");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos resolver la verificación.");
  }
}
