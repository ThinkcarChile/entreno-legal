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

/**
 * Revisión de una llegada que no se verificó sola.
 *
 * El motivo es obligatorio y queda en la línea de tiempo del trabajo: una
 * decisión sobre el trabajo de alguien tiene que poder leerse después.
 */
export async function reviewCheckInAction(
  checkInId: string,
  approved: boolean,
  reason: string,
): Promise<ActionResult<void>> {
  try {
    if (reason.trim().length < 5) {
      return { ok: false, error: "Escribe el motivo de la decisión.", field: "reason" };
    }
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("review_check_in", {
      p_check_in_id: checkInId,
      p_approved: approved,
      p_reason: reason.trim(),
    });
    if (error) return actionError(error, "No pudimos registrar la revisión.");
    revalidatePath("/admin/check-ins");
    revalidatePath("/admin");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos registrar la revisión.");
  }
}

/**
 * Resolución de una disputa.
 *
 * Decide qué corresponde y lo deja escrito: libera, recorta o cancela el pago
 * al trabajador y anota el importe a devolver al cliente. **No ejecuta ninguna
 * devolución**: eso necesita el proveedor de pago integrado, y la interfaz lo
 * dice con esas palabras.
 */
export async function resolveDisputeAction(
  disputeId: string,
  resolution: "WORKER_WINS" | "CLIENT_WINS" | "PARTIAL",
  notes: string,
  refundAmount?: number | null,
): Promise<ActionResult<{ payoutStatus: string | null; refund: number }>> {
  try {
    if (notes.trim().length < 10) {
      return { ok: false, error: "La resolución necesita un motivo escrito.", field: "notes" };
    }
    if (resolution === "PARTIAL" && (!refundAmount || refundAmount <= 0)) {
      return {
        ok: false,
        error: "Una resolución parcial necesita un monto a devolver.",
        field: "refundAmount",
      };
    }

    const { supabase } = await requireSession();
    const { data, error } = await supabase.rpc("resolve_dispute", {
      p_dispute_id: disputeId,
      p_resolution: resolution,
      p_notes: notes.trim(),
      p_refund_amount: refundAmount ?? null,
    });
    if (error) return actionError(error, "No pudimos resolver la disputa.");

    const row = (data ?? {}) as Record<string, unknown>;
    revalidatePath("/admin/disputas");
    revalidatePath("/admin");
    return actionOk({
      payoutStatus: (row.payout_status as string | null) ?? null,
      refund: Number(row.refund_registered ?? 0),
    });
  } catch (error) {
    return actionError(error, "No pudimos resolver la disputa.");
  }
}

export async function approvePayoutAction(
  payoutId: string,
  notes?: string,
): Promise<ActionResult<void>> {
  try {
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("approve_payout", {
      p_payout_id: payoutId,
      p_notes: notes?.trim() || null,
    });
    if (error) return actionError(error, "No pudimos aprobar el pago.");
    revalidatePath("/admin/payouts");
    revalidatePath("/admin");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos aprobar el pago.");
  }
}

/**
 * Registra una transferencia que una persona hizo por fuera.
 *
 * La plataforma no mueve dinero en esta etapa: esto es el asiento contable de
 * algo que ya ocurrió, con su referencia bancaria. Sin referencia no se guarda.
 */
export async function markPayoutPaidAction(
  payoutId: string,
  bankReference: string,
  paidAt?: string,
  notes?: string,
): Promise<ActionResult<void>> {
  try {
    if (bankReference.trim().length < 4) {
      return {
        ok: false,
        error: "Escribe la referencia de la transferencia.",
        field: "bankReference",
      };
    }
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("mark_payout_paid", {
      p_payout_id: payoutId,
      p_bank_reference: bankReference.trim(),
      p_paid_at: paidAt || null,
      p_notes: notes?.trim() || null,
    });
    if (error) return actionError(error, "No pudimos registrar la transferencia.");
    revalidatePath("/admin/payouts");
    revalidatePath("/admin");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos registrar la transferencia.");
  }
}

export async function holdPayoutAction(
  payoutId: string,
  reason: string,
): Promise<ActionResult<void>> {
  try {
    if (reason.trim().length < 5) {
      return { ok: false, error: "Escribe el motivo de la retención.", field: "reason" };
    }
    const { supabase } = await requireSession();
    const { error } = await supabase.rpc("hold_payout", {
      p_payout_id: payoutId,
      p_reason: reason.trim(),
    });
    if (error) return actionError(error, "No pudimos retener el pago.");
    revalidatePath("/admin/payouts");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos retener el pago.");
  }
}
