"use server";

import { revalidatePath } from "next/cache";

import { attemptRefundIdempotencyKey, performAttemptRefund } from "@/lib/payments/attempt-refund";
import { paymentLog } from "@/lib/payments/logging";
import { reconcilePayments } from "@/lib/payments/reconcile";
import { performRefund, refundIdempotencyKey, type RefundState } from "@/lib/payments/refund";
import { reconcileAttemptRefunds, reconcileRefunds } from "@/lib/payments/refund-reconcile";
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
 * desde el navegador: se leen de la base a partir del identificador del pago
 * (o del intento, en la devolución de un cobro duplicado).
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

/** Un UUID: lo que genera `crypto.randomUUID()` en el formulario. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Conciliación manual.
 *
 * Sin `paymentId` recorre la cola entera; con él, resuelve un caso concreto,
 * que es lo que hace falta cuando alguien escribe preguntando por su pago.
 */
export async function reconcilePaymentsAction(paymentId?: string): Promise<
  ActionResult<{ examined: number; changed: number; expired: number; refundsResolved: number }>
> {
  try {
    const { userId } = await requireAdmin();

    const admin = createAdminClient();
    const summary = await reconcilePayments(admin, {
      paymentId,
      // Sin margen cuando se pide un pago concreto: quien lo pide ya sabe que
      // ese pago está esperando respuesta.
      olderThanMinutes: paymentId ? 0 : 5,
    });

    // Y sus devoluciones por confirmar. Sobre un pago concreto se pregunta
    // aunque se haya preguntado hace poco; el margen para dar una devolución
    // por NO hecha lo aplica igual `decideUnknownRefund`.
    const refunds = await reconcileRefunds(admin, {
      paymentId,
      minAgeMinutes: paymentId ? 0 : 10,
    });
    // Y las de cobros duplicados, contra el token de su intento.
    const attemptRefunds = await reconcileAttemptRefunds(admin, {
      paymentId,
      minAgeMinutes: paymentId ? 0 : 10,
    });

    paymentLog({
      operation: "admin",
      result:
        `reconcile:${summary.changed}/${summary.examined} expirados:${summary.expired}` +
        ` devoluciones:${refunds.resolved}/${refunds.examined}` +
        ` duplicados:${attemptRefunds.resolved}/${attemptRefunds.examined}`,
      paymentId,
      correlationId: userId.slice(0, 8),
    });

    revalidatePath("/admin/pagos");
    revalidatePath("/admin");
    return actionOk({
      examined: summary.examined,
      changed: summary.changed,
      expired: summary.expired,
      refundsResolved: refunds.resolved + attemptRefunds.resolved,
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
 * `requestId` lo genera el formulario al abrirse y cambia después de cada
 * respuesta: identifica UNA petición. Repetirla —un doble clic, un reenvío
 * tras perder la respuesta— no pide dos veces al banco; una segunda
 * devolución, aunque sea del mismo importe, es otra petición y sí ocurre.
 *
 * Contesta en qué quedó: confirmada, rechazada (no salió dinero; se puede
 * volver a pedir), por confirmar (el banco no dio respuesta en firme: no se
 * puede pedir otra hasta resolverla) o en curso (la misma petición ya la está
 * procesando otra llamada).
 */
export async function requestRefundAction(input: {
  paymentId: string;
  amount: number;
  reason: string;
  disputeId?: string;
  /** Identificador de la petición, generado por el formulario. */
  requestId: string;
}): Promise<
  ActionResult<{ state: RefundState; kind: string; refundedAmount: number; reason: string | null }>
> {
  try {
    // La sesión de quien administra: con ella se pide la devolución.
    const { supabase } = await requireAdmin();

    if (!REQUEST_ID.test(input.requestId ?? "")) {
      return {
        ok: false,
        error: "No pudimos identificar la petición. Cierra el formulario y vuelve a abrirlo.",
      };
    }
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

    // La petición va con la sesión de quien administra (la base comprueba su
    // rol); la reserva del envío, la lectura del token y el cierre, con la
    // clave de servicio.
    const admin = createAdminClient();
    const outcome = await performRefund(supabase, admin, {
      paymentId: input.paymentId,
      amount: input.amount,
      reason: input.reason.trim(),
      disputeId: input.disputeId ?? null,
      idempotencyKey: refundIdempotencyKey(input.paymentId, input.requestId),
    });

    revalidatePath("/admin/pagos");
    revalidatePath("/admin/disputas");
    revalidatePath("/admin");

    return actionOk({
      state: outcome.state,
      kind: outcome.kind,
      refundedAmount: outcome.refundedAmount,
      reason: outcome.reason ?? null,
    });
  } catch (error) {
    return actionError(error, "No pudimos ejecutar la devolución.");
  }
}

/**
 * Cierra a mano una devolución por confirmar, con lo que muestra el portal de
 * Transbank.
 *
 * Es para cuando la conciliación no puede decidir: fuera de los 7 días en que
 * Webpay contesta, o con un estado que no cuadra con lo registrado. La base
 * comprueba el rol, que la devolución esté por confirmar y que una reversa sea
 * por el total; la nota queda en la auditoría.
 */
export async function resolveUnknownRefundAction(input: {
  refundId: string;
  succeeded: boolean;
  kind?: "REVERSED" | "NULLIFIED";
  note: string;
}): Promise<ActionResult<{ refundStatus: string }>> {
  try {
    const { supabase } = await requireAdmin();

    if (input.note.trim().length < 10) {
      return {
        ok: false,
        error: "Escribe lo que muestra el portal de Transbank (al menos 10 caracteres).",
        field: "note",
      };
    }

    const { data, error } = await supabase.rpc("resolve_unknown_refund", {
      p_refund_id: input.refundId,
      p_succeeded: input.succeeded,
      p_kind: input.succeeded ? (input.kind ?? null) : null,
      p_note: input.note.trim(),
    });
    if (error) return actionError(error, "No pudimos cerrar la devolución.");

    paymentLog({
      operation: "admin",
      result: `refund_resolved_manually:${input.succeeded ? "done" : "not_done"}`,
    });

    revalidatePath("/admin/pagos");
    revalidatePath("/admin");
    const row = (data ?? {}) as Record<string, unknown>;
    return actionOk({ refundStatus: String(row.refund_status ?? "") });
  } catch (error) {
    return actionError(error, "No pudimos cerrar la devolución.");
  }
}

/**
 * Devuelve el cobro de un intento: un cobro duplicado, o un intento que salió
 * de la ventana con indicios de cobro.
 *
 * Va contra el token de ESE intento y por su cobro entero, que fija la base:
 * del navegador solo llegan el intento, el motivo y el identificador de la
 * petición. La base comprueba el rol, que el intento sea un duplicado o esté
 * en revisión, que no sea el que respalda el pago del trabajo y que no haya
 * otra devolución abierta o hecha. El pago del trabajo no se toca.
 */
export async function requestAttemptRefundAction(input: {
  attemptId: string;
  reason: string;
  /** Identificador de la petición, generado por el formulario. */
  requestId: string;
}): Promise<
  ActionResult<{ state: RefundState; kind: string; refundedAmount: number; reason: string | null }>
> {
  try {
    const { supabase } = await requireAdmin();

    if (!REQUEST_ID.test(input.requestId ?? "")) {
      return {
        ok: false,
        error: "No pudimos identificar la petición. Cierra el formulario y vuelve a abrirlo.",
      };
    }
    if (input.reason.trim().length < 10) {
      return {
        ok: false,
        error: "Escribe el motivo de la devolución (al menos 10 caracteres).",
        field: "reason",
      };
    }

    const admin = createAdminClient();
    const outcome = await performAttemptRefund(supabase, admin, {
      attemptId: input.attemptId,
      reason: input.reason.trim(),
      idempotencyKey: attemptRefundIdempotencyKey(input.attemptId, input.requestId),
    });

    revalidatePath("/admin/pagos");
    revalidatePath("/admin");

    return actionOk({
      state: outcome.state,
      kind: outcome.kind,
      refundedAmount: outcome.refundedAmount,
      reason: outcome.reason ?? null,
    });
  } catch (error) {
    return actionError(error, "No pudimos ejecutar la devolución del cobro duplicado.");
  }
}

/**
 * Cierra a mano la devolución por confirmar de un cobro duplicado, con lo que
 * muestra el portal de Transbank para la orden de compra de ese intento. Mismas
 * reglas que `resolveUnknownRefundAction`; la nota queda en la auditoría.
 */
export async function resolveUnknownAttemptRefundAction(input: {
  refundId: string;
  succeeded: boolean;
  kind?: "REVERSED" | "NULLIFIED";
  note: string;
}): Promise<ActionResult<{ refundStatus: string }>> {
  try {
    const { supabase } = await requireAdmin();

    if (input.note.trim().length < 10) {
      return {
        ok: false,
        error: "Escribe lo que muestra el portal de Transbank (al menos 10 caracteres).",
        field: "note",
      };
    }

    const { data, error } = await supabase.rpc("resolve_unknown_attempt_refund", {
      p_refund_id: input.refundId,
      p_succeeded: input.succeeded,
      p_kind: input.succeeded ? (input.kind ?? null) : null,
      p_note: input.note.trim(),
    });
    if (error) return actionError(error, "No pudimos cerrar la devolución.");

    paymentLog({
      operation: "admin",
      result: `attempt_refund_resolved_manually:${input.succeeded ? "done" : "not_done"}`,
    });

    revalidatePath("/admin/pagos");
    revalidatePath("/admin");
    const row = (data ?? {}) as Record<string, unknown>;
    return actionOk({ refundStatus: String(row.refund_status ?? "") });
  } catch (error) {
    return actionError(error, "No pudimos cerrar la devolución.");
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
