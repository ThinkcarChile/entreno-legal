import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getPaymentProviderForExistingPayments } from "./index";
import {
  dispatchRefund,
  paymentStatusOf,
  type RefundBook,
  type RefundOutcome,
  type RegisteredRefund,
} from "./refund";

/**
 * Devolver el cobro de UN INTENTO: un cobro duplicado (DOUBLE_CHARGE), o un
 * intento que salió de la ventana con indicios de cobro (UNDER_REVIEW).
 *
 * Las devoluciones de un pago (`refund.ts`) van al token del pago, que es el
 * del intento que pagó el trabajo. Devolver por ahí el duplicado habría
 * devuelto el cobro bueno. Esta va al token del intento duplicado, por su
 * cobro entero —lo decide la base, no el formulario— y no toca el pago.
 *
 * Los pasos y la regla son los mismos que en `refund.ts`, y el código que
 * llama al banco y lee su respuesta también (`dispatchRefund`):
 *
 * 1. `request_attempt_refund`, con la sesión de quien administra;
 * 2. `claim_attempt_refund`: una sola llamada al banco por devolución;
 * 3. `refundTransaction` con el token del intento, y se cierra con
 *    `settle_attempt_refund` (hecha o rechazada) o
 *    `mark_attempt_refund_unknown` (no se sabe: la conciliación o una
 *    persona lo resuelven).
 */

export interface AttemptRefundRequest {
  /** El intento cuyo cobro se devuelve. */
  attemptId: string;
  reason: string;
  /** Clave de esta petición (ver `attemptRefundIdempotencyKey`). */
  idempotencyKey: string;
}

/**
 * Clave de idempotencia de la devolución de un intento: el intento y el
 * identificador que nace con el formulario. Lleva otro prefijo que la de un
 * pago para que las dos no se crucen nunca en un registro.
 */
export function attemptRefundIdempotencyKey(attemptId: string, requestId: string): string {
  const digest = createHash("sha256")
    .update(`attempt:${attemptId}:${requestId}`)
    .digest("hex")
    .slice(0, 32);
  return `attempt-refund:${digest}`;
}

/**
 * Pide la devolución del cobro de un intento y la cierra con lo que conteste
 * el banco. Que el intento sea un duplicado, que no sea el que respalda el
 * pago y que no haya otra devolución abierta o hecha lo comprueba la base.
 */
export async function performAttemptRefund(
  /** Sesión de quien administra: `request_attempt_refund` exige el rol. */
  requester: SupabaseClient,
  /** Clave de servicio: reserva, token del intento y cierre. */
  admin: SupabaseClient,
  request: AttemptRefundRequest,
): Promise<RefundOutcome> {
  const provider = getPaymentProviderForExistingPayments();

  const { data: refundId, error: requestError } = await requester.rpc("request_attempt_refund", {
    p_attempt_id: request.attemptId,
    p_reason: request.reason,
    p_provider_event_id: request.idempotencyKey,
  });
  if (requestError) throw new Error(requestError.message);

  const id = String(refundId);
  const { data: refund } = await admin
    .from("payment_attempt_refunds")
    .select("payment_id")
    .eq("id", id)
    .maybeSingle<{ payment_id: string }>();

  return dispatchRefund(
    attemptRefundBook(admin, request.attemptId, refund?.payment_id ?? ""),
    provider,
    id,
  );
}

function attemptRefundBook(admin: SupabaseClient, attemptId: string, paymentId: string): RefundBook {
  return {
    paymentId,
    async claim(refundId) {
      const { data, error } = await admin.rpc("claim_attempt_refund", { p_refund_id: refundId });
      if (error) throw new Error(error.message);
      return data === true;
    },
    async target(refundId) {
      // El importe es el que fijó la base (el cobro entero del intento); el
      // token, el del intento. Ninguno de los dos viene del navegador.
      const [{ data: refund }, { data: attempt }] = await Promise.all([
        admin
          .from("payment_attempt_refunds")
          .select("amount")
          .eq("id", refundId)
          .maybeSingle<{ amount: number }>(),
        admin
          .from("payment_attempts")
          .select("provider_token")
          .eq("id", attemptId)
          .maybeSingle<{ provider_token: string | null }>(),
      ]);
      if (!attempt?.provider_token || !refund) return null;
      return {
        token: attempt.provider_token,
        providerTransactionId: attempt.provider_token,
        amount: Number(refund.amount),
      };
    },
    async settle(refundId, input) {
      const { data, error } = await admin.rpc("settle_attempt_refund", {
        p_refund_id: refundId,
        p_confirmed: input.confirmed,
        p_kind: input.kind,
        p_refunded: input.refunded,
        p_details: input.details,
      });
      return { data: (data ?? null) as Record<string, unknown> | null, error };
    },
    async markUnknown(refundId, reason, details) {
      const { error } = await admin.rpc("mark_attempt_refund_unknown", {
        p_refund_id: refundId,
        p_reason: reason,
        p_details: details,
      });
      if (error) throw new Error(error.message);
    },
    paymentStatus: () => paymentStatusOf(admin, paymentId),
    async registered(refundId) {
      const { data } = await admin
        .from("payment_attempt_refunds")
        .select("status,kind,amount,failure_reason,unknown_reason")
        .eq("id", refundId)
        .maybeSingle<RegisteredRefund>();
      return data ?? null;
    },
  };
}
