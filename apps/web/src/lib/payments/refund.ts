import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getPaymentProvider } from "./index";
import { errorCategory, paymentLog } from "./logging";
import { isReconcilable } from "./provider";

/**
 * Devoluciones.
 *
 * Dos pasos y una regla: **nada se marca como devuelto por haberlo pedido**.
 * Primero se deja constancia de la petición en la base, luego se llama al
 * proveedor, y solo si el proveedor confirma se cierra la devolución y se
 * reduce el saldo del pago.
 *
 * Entre los dos pasos hay una llamada a un banco, que puede tardar o no
 * contestar. Si no contesta, la devolución se queda en `REQUESTED` y sin
 * efecto contable, que es exactamente lo correcto: no sabemos si el dinero
 * salió, y no vamos a decir que sí.
 *
 * Webpay resuelve una devolución de dos formas distintas según el importe y el
 * momento —reversa o anulación—, con respuestas de forma distinta. Las dos se
 * soportan; ver `transbank/mapping.ts`.
 */

export interface RefundRequest {
  paymentId: string;
  amount: number;
  reason: string;
  disputeId?: string | null;
  /** Clave de idempotencia. Si se repite, no se pide dos veces al banco. */
  idempotencyKey: string;
}

export interface RefundOutcome {
  refundId: string;
  confirmed: boolean;
  kind: "REVERSED" | "NULLIFIED" | "UNKNOWN";
  refundedAmount: number;
  paymentStatus: string;
  reason?: string;
}

/**
 * Clave de idempotencia de una devolución.
 *
 * Se construye con datos NO secretos: el pago, el importe y un discriminante
 * que aporta quien la pide (la disputa, o un identificador de la operación
 * administrativa). El token no entra: es un secreto operativo, y una clave de
 * idempotencia acaba en registros y en índices.
 */
export function refundIdempotencyKey(
  paymentId: string,
  amount: number,
  discriminator: string,
): string {
  const digest = createHash("sha256")
    .update(`${paymentId}:${amount}:${discriminator}`)
    .digest("hex")
    .slice(0, 32);
  return `refund:${digest}`;
}

/**
 * Pide la devolución al proveedor y la cierra con lo que conteste.
 *
 * `admin` es el cliente con la clave de servicio. La autorización —que quien
 * pide sea administración, que la disputa esté resuelta, que haya saldo— la
 * comprueba `request_payment_refund` dentro de la base, no esta función.
 */
export async function performRefund(
  admin: SupabaseClient,
  request: RefundRequest,
): Promise<RefundOutcome> {
  const provider = getPaymentProvider();

  const { data: refundId, error: requestError } = await admin.rpc("request_payment_refund", {
    p_payment_id: request.paymentId,
    p_amount: request.amount,
    p_reason: request.reason,
    p_provider_event_id: request.idempotencyKey,
    p_dispute_id: request.disputeId ?? null,
  });
  if (requestError) throw new Error(requestError.message);

  const id = String(refundId);

  // Si esta clave ya estaba cerrada, no se vuelve a llamar al banco.
  const { data: existing } = await admin
    .from("payment_refunds")
    .select("status,kind,amount")
    .eq("id", id)
    .maybeSingle<{ status: string; kind: string | null; amount: number }>();

  if (existing && existing.status !== "REQUESTED") {
    const { data: payment } = await admin
      .from("payments")
      .select("status")
      .eq("id", request.paymentId)
      .maybeSingle<{ status: string }>();
    return {
      refundId: id,
      confirmed: existing.status === "CONFIRMED",
      kind: (existing.kind as RefundOutcome["kind"]) ?? "UNKNOWN",
      refundedAmount: existing.status === "CONFIRMED" ? existing.amount : 0,
      paymentStatus: payment?.status ?? "",
      reason: "devolución ya resuelta",
    };
  }

  if (!isReconcilable(provider)) {
    await admin.rpc("settle_payment_refund", {
      p_refund_id: id,
      p_confirmed: false,
      p_details: { failure_reason: "provider_without_refund_support" },
    });
    throw new Error("El proveedor activo no admite devoluciones.");
  }

  const { data: tokenRow } = await admin
    .from("payments")
    .select("provider_token,provider_transaction_id")
    .eq("id", request.paymentId)
    .maybeSingle<{ provider_token: string | null; provider_transaction_id: string | null }>();

  if (!tokenRow?.provider_token) {
    await admin.rpc("settle_payment_refund", {
      p_refund_id: id,
      p_confirmed: false,
      p_details: { failure_reason: "missing_token" },
    });
    throw new Error("El pago no tiene token del proveedor: no se puede devolver.");
  }

  let providerResult;
  try {
    providerResult = await provider.refundTransaction({
      providerTransactionId: tokenRow.provider_transaction_id ?? tokenRow.provider_token,
      token: tokenRow.provider_token,
      amount: { amount: request.amount, currency: "CLP" },
    });
  } catch (error) {
    // El banco no contestó o rechazó. La devolución queda FAILED y el saldo
    // del pago no se toca: no se devolvió nada.
    await admin.rpc("settle_payment_refund", {
      p_refund_id: id,
      p_confirmed: false,
      p_details: { failure_reason: errorCategory(error) },
    });
    paymentLog({
      operation: "refund",
      result: "error",
      paymentId: request.paymentId,
      errorCategory: errorCategory(error),
    });
    throw error;
  }

  const { data: settled, error: settleError } = await admin.rpc("settle_payment_refund", {
    p_refund_id: id,
    p_confirmed: providerResult.confirmed,
    p_kind: providerResult.confirmed ? providerResult.kind : null,
    p_refunded: providerResult.confirmed ? providerResult.refundedAmount : null,
    p_details: {
      authorization_code: providerResult.authorizationCode,
      authorization_date: providerResult.authorizationDate,
      nullified_amount: providerResult.refundedAmount,
      balance: providerResult.balance,
      response_code: providerResult.responseCode,
      raw: providerResult.raw,
      failure_reason: providerResult.confirmed ? null : "provider_rejected",
    },
  });
  if (settleError) throw new Error(settleError.message);

  const row = (settled ?? {}) as Record<string, unknown>;

  paymentLog({
    operation: "refund",
    result: providerResult.confirmed ? `confirmed:${providerResult.kind}` : "rejected",
    paymentId: request.paymentId,
    environment: provider.environment,
  });

  return {
    refundId: id,
    confirmed: providerResult.confirmed,
    kind: providerResult.kind,
    refundedAmount: providerResult.confirmed ? providerResult.refundedAmount : 0,
    paymentStatus: String(row.payment_status ?? ""),
  };
}
