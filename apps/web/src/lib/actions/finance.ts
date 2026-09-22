"use server";

import { revalidatePath } from "next/cache";

import { paymentLog } from "@/lib/payments/logging";
import { reconcilePayments } from "@/lib/payments/reconcile";
import { performRefund, refundIdempotencyKey } from "@/lib/payments/refund";
import { createAdminClient } from "@/lib/supabase/admin";
import { actionError, actionOk, type ActionResult } from "@/lib/utils/errors";

import { getViewer } from "@/lib/auth/session";

import { requireSession } from "./guards";

/**
 * Acciones financieras de administración: conciliar y devolver.
 *
 * Todas comprueban administración **en la base**, no aquí. Esta capa existe
 * para no dejar abierto un camino: la comprobación de este archivo es la
 * primera puerta, y la de la RPC es la que de verdad cierra. Un usuario común
 * que llame a la acción por su cuenta choca contra la segunda.
 *
 * Ninguna de estas operaciones acepta importes, tokens ni órdenes de compra
 * desde el navegador: se leen de la base a partir del identificador del pago.
 */

/**
 * Lanza si quien llama no es administración.
 *
 * Es la primera de dos puertas. El rol se lee del perfil, con la sesión real
 * del usuario, no de nada que venga en la petición. La segunda puerta —la que
 * de verdad cierra— está dentro de cada RPC.
 */
async function requireAdmin() {
  const session = await requireSession();
  const viewer = await getViewer();
  if (!viewer?.isAdmin) {
    throw new Error("Solo la administración puede ejecutar esta operación.");
  }
  return session;
}

/**
 * Conciliación manual.
 *
 * Sin `paymentId` recorre la cola entera; con él, resuelve un caso concreto,
 * que es lo que hace falta cuando alguien escribe preguntando por su pago.
 */
export async function reconcilePaymentsAction(
  paymentId?: string,
): Promise<ActionResult<{ examined: number; changed: number; expired: number }>> {
  try {
    const { userId } = await requireAdmin();

    const admin = createAdminClient();
    const summary = await reconcilePayments(admin, {
      paymentId,
      // Sin margen cuando se pide un pago concreto: quien lo pide ya sabe que
      // ese pago está esperando respuesta.
      olderThanMinutes: paymentId ? 0 : 5,
    });

    paymentLog({
      operation: "admin",
      result: `reconcile:${summary.changed}/${summary.examined} expirados:${summary.expired}`,
      paymentId,
      correlationId: userId.slice(0, 8),
    });

    revalidatePath("/admin/pagos");
    revalidatePath("/admin");
    return actionOk({
      examined: summary.examined,
      changed: summary.changed,
      expired: summary.expired,
    });
  } catch (error) {
    return actionError(error, "No pudimos conciliar los pagos.");
  }
}

/**
 * Devolución iniciada por administración.
 *
 * Un usuario común NUNCA llega aquí: no hay botón, no hay acción y la RPC
 * lo rechaza. El motivo es obligatorio y queda en la auditoría junto a quién
 * lo pidió.
 *
 * La clave de idempotencia se deriva del pago, el importe y la disputa (o de
 * un discriminante explícito). Repetir el mismo formulario no pide dos
 * devoluciones al banco.
 */
export async function requestRefundAction(input: {
  paymentId: string;
  amount: number;
  reason: string;
  disputeId?: string;
  /** Distingue dos devoluciones legítimas del mismo importe sobre el mismo pago. */
  discriminator?: string;
}): Promise<ActionResult<{ confirmed: boolean; kind: string; refundedAmount: number }>> {
  try {
    await requireAdmin();

    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      return { ok: false, error: "El importe debe ser un número entero de pesos.", field: "amount" };
    }
    if (input.reason.trim().length < 10) {
      return {
        ok: false,
        error: "Escribe el motivo de la devolución (al menos 10 caracteres).",
        field: "reason",
      };
    }

    const admin = createAdminClient();
    const outcome = await performRefund(admin, {
      paymentId: input.paymentId,
      amount: input.amount,
      reason: input.reason.trim(),
      disputeId: input.disputeId ?? null,
      idempotencyKey: refundIdempotencyKey(
        input.paymentId,
        input.amount,
        input.discriminator ?? input.disputeId ?? "admin",
      ),
    });

    revalidatePath("/admin/pagos");
    revalidatePath("/admin/disputas");
    revalidatePath("/admin");

    if (!outcome.confirmed) {
      return {
        ok: false,
        error:
          "El proveedor no confirmó la devolución. No se devolvió nada y queda registrada como fallida.",
      };
    }

    return actionOk({
      confirmed: outcome.confirmed,
      kind: outcome.kind,
      refundedAmount: outcome.refundedAmount,
    });
  } catch (error) {
    return actionError(error, "No pudimos ejecutar la devolución.");
  }
}

/** Marca un pago para revisión manual, con motivo. */
export async function flagPaymentForReviewAction(
  paymentId: string,
  reason: string,
): Promise<ActionResult<void>> {
  try {
    await requireAdmin();
    if (reason.trim().length < 5) {
      return { ok: false, error: "Escribe el motivo de la revisión.", field: "reason" };
    }

    const admin = createAdminClient();
    const { error } = await admin
      .from("payments")
      .update({ status: "UNDER_REVIEW", review_reason: reason.trim() })
      .eq("id", paymentId)
      .in("status", ["PENDING", "CREATED", "AUTHORIZED", "PAID"]);
    if (error) return actionError(error, "No pudimos marcar el pago para revisión.");

    paymentLog({ operation: "admin", result: "flagged", paymentId, reason: reason.trim() });
    revalidatePath("/admin/pagos");
    return actionOk();
  } catch (error) {
    return actionError(error, "No pudimos marcar el pago para revisión.");
  }
}
