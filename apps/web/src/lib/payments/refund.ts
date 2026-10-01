import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getPaymentProviderForExistingPayments } from "./index";
import { errorCategory, paymentLog } from "./logging";
import {
  isReconcilable,
  PaymentProviderError,
  PaymentProviderNotConfiguredError,
  type PaymentProvider,
  type ProviderRefundResult,
} from "./provider";

/**
 * Devoluciones.
 *
 * Tres pasos y una regla: **nada se marca como devuelto por haberlo pedido, y
 * nada se marca como no devuelto sin saberlo**.
 *
 * 1. Se deja constancia de la petición en la base (`request_payment_refund`).
 * 2. Se reserva el envío (`claim_payment_refund`): solo una llamada al banco
 *    por devolución, aunque la misma petición llegue dos veces a la vez.
 * 3. Se llama al banco y se cierra con lo que conteste.
 *
 * Lo que conteste puede ser tres cosas, y cada una se registra distinto:
 *
 * · **la hizo** → CONFIRMED, y baja el saldo del pago;
 * · **dijo que no**, o la petición no llegó a salir → FAILED. No se devolvió
 *   nada y se puede volver a pedir;
 * · **no se sabe** —se agotó el tiempo, se cortó la red, contestó 5xx o algo
 *   que no se entiende— → UNKNOWN. El banco pudo haberla hecho. La devolución
 *   sigue comprometiendo saldo y bloquea cualquier otra sobre el mismo pago
 *   hasta que la conciliación (`refund-reconcile.ts`) o una persona digan qué
 *   pasó. Marcarla FAILED, como se hacía, dejaba el saldo libre y el
 *   reintento devolvía dos veces.
 *
 * Webpay resuelve una devolución de dos formas según el importe y el momento
 * —reversa o anulación—, con respuestas de forma distinta. Las dos se
 * soportan; ver `transbank/mapping.ts`.
 */

export interface RefundRequest {
  paymentId: string;
  amount: number;
  reason: string;
  disputeId?: string | null;
  /**
   * Clave de idempotencia de ESTA petición (ver `refundIdempotencyKey`). Si se
   * repite, no se pide dos veces al banco: se devuelve lo que pasó con la
   * primera.
   */
  idempotencyKey: string;
}

/** En qué quedó una devolución, tal como se le cuenta a quien la pidió. */
export type RefundState = "CONFIRMED" | "FAILED" | "UNKNOWN" | "IN_PROGRESS";

export interface RefundOutcome {
  refundId: string;
  state: RefundState;
  /** `true` solo si el banco la confirmó. */
  confirmed: boolean;
  kind: "REVERSED" | "NULLIFIED" | "UNKNOWN";
  refundedAmount: number;
  paymentStatus: string;
  /** Por qué no se confirmó: motivo del rechazo o de la duda. */
  reason?: string;
  /** La petición ya se había procesado: esta vez no se llamó al banco. */
  replayed?: boolean;
}

/**
 * Clave de idempotencia de una devolución.
 *
 * Identifica UNA petición de administración: el pago y un identificador que
 * nace con el formulario (`requestId`). Un doble clic o un reenvío de la misma
 * petición llevan la misma clave y no piden dos veces; una segunda devolución
 * del mismo importe es otra petición, con otra clave, y sí ocurre.
 *
 * Antes la clave salía del importe y de la disputa: dos devoluciones parciales
 * iguales chocaban (la segunda «se confirmaba» sin salir dinero) y una fallida
 * no se podía reintentar. El token no entra: es un secreto operativo, y una
 * clave de idempotencia acaba en registros y en índices.
 */
export function refundIdempotencyKey(paymentId: string, requestId: string): string {
  const digest = createHash("sha256")
    .update(`${paymentId}:${requestId}`)
    .digest("hex")
    .slice(0, 32);
  return `refund:${digest}`;
}

/** Una devolución que no se confirmó: rechazada en firme, o sin saber qué pasó. */
export type RefundFailureClass =
  | { outcome: "REJECTED"; reason: string }
  | { outcome: "UNKNOWN"; reason: string };

/** Lo que el banco dijo, o dejó de decir, al pedirle la devolución. */
export type RefundAttemptClass = { outcome: "CONFIRMED" } | RefundFailureClass;

/**
 * Clasifica un error de la llamada de devolución.
 *
 * Solo dos casos permiten afirmar que NO se devolvió nada: que la petición no
 * llegara a salir, y que Transbank contestara con un 4xx (rechazó la
 * petición). Todo lo demás —tiempo agotado, red, 5xx, un error que no
 * sabemos leer— queda como desconocido: suponer que no salió es lo que
 * permitía devolver dos veces.
 */
export function classifyRefundError(error: unknown): RefundFailureClass {
  if (error instanceof PaymentProviderNotConfiguredError) {
    return { outcome: "REJECTED", reason: "not_sent" };
  }
  if (error instanceof PaymentProviderError) {
    if (error.requestSent === false) return { outcome: "REJECTED", reason: "not_sent" };
    if (error.httpStatus !== null && error.httpStatus >= 400 && error.httpStatus < 500) {
      return { outcome: "REJECTED", reason: `provider_http_${error.httpStatus}` };
    }
    if (error.httpStatus !== null && error.httpStatus >= 500) {
      return { outcome: "UNKNOWN", reason: `provider_http_${error.httpStatus}` };
    }
  }
  const category = errorCategory(error);
  return {
    outcome: "UNKNOWN",
    reason: category === "timeout" || category === "network" ? category : "unknown_error",
  };
}

/**
 * Clasifica una respuesta del banco.
 *
 * Una reversa, o una anulación con `response_code` 0, es una devolución hecha.
 * Una anulación con otro código es un rechazo en firme. Una respuesta sin tipo
 * reconocible, o una anulación sin código, no dice nada: queda desconocida.
 */
export function classifyRefundResult(result: ProviderRefundResult): RefundAttemptClass {
  if (result.confirmed) return { outcome: "CONFIRMED" };
  if (result.kind === "UNKNOWN" || result.responseCode === null) {
    return { outcome: "UNKNOWN", reason: "unparsable_response" };
  }
  return { outcome: "REJECTED", reason: "provider_rejected" };
}

/**
 * Pide la devolución al proveedor y la cierra con lo que conteste.
 *
 * La autorización —que quien pide sea administración, que la disputa esté
 * resuelta, que haya saldo, que no haya otra abierta— la comprueba
 * `request_payment_refund` dentro de la base, no esta función.
 */
export async function performRefund(
  /**
   * Cliente con la SESIÓN de quien administra. `request_payment_refund` exige
   * `app_private.is_admin()` sobre `auth.uid()` y solo está concedida a
   * `authenticated`: con la clave de servicio no hay usuario y la base la
   * rechaza con «permission denied». Así es como estuvo hasta que la auditoría
   * lo encontró: el panel no podía devolver nada.
   */
  requester: SupabaseClient,
  /**
   * Cliente con la clave de servicio: reserva el envío, lee el token (ningún
   * usuario puede) y cierra con `settle_payment_refund` o
   * `mark_payment_refund_unknown`, exclusivas de `service_role`.
   */
  admin: SupabaseClient,
  request: RefundRequest,
): Promise<RefundOutcome> {
  const provider = getPaymentProviderForExistingPayments();

  const { data: refundId, error: requestError } = await requester.rpc("request_payment_refund", {
    p_payment_id: request.paymentId,
    p_amount: request.amount,
    p_reason: request.reason,
    p_provider_event_id: request.idempotencyKey,
    p_dispute_id: request.disputeId ?? null,
  });
  if (requestError) throw new Error(requestError.message);

  return dispatchRefund(paymentRefundBook(admin, request), provider, String(refundId));
}

/* ------------------------------------------------- el envío, para los dos */

/**
 * Lo que cambia entre devolver el cobro de un PAGO (`payment_refunds`) y el de
 * un INTENTO (`payment_attempt_refunds`, un cobro duplicado): qué funciones de
 * la base reservan, cierran o dejan por confirmar, qué token se usa y por qué
 * importe. Lo demás —una sola llamada al banco, cómo se lee lo que conteste,
 * qué se registra con cada respuesta— es lo mismo y vive en `dispatchRefund`.
 *
 * Cada implementación llama a las funciones por su nombre escrito, para que
 * `check-db-contract.sh` las encuentre.
 */
export interface RefundBook {
  /** El pago al que pertenece lo que se devuelve. Solo para el registro. */
  paymentId: string;
  /** `claim_…`: `true` solo para la primera llamada. */
  claim(refundId: string): Promise<boolean>;
  /**
   * La transacción a la que va la devolución y por cuánto. `null` si no hay
   * token: no se puede pedir al banco.
   */
  target(refundId: string): Promise<RefundTarget | null>;
  /** `settle_…`, con la respuesta del banco. */
  settle(refundId: string, input: RefundSettlement): Promise<RefundSettleResult>;
  /** `mark_…_unknown`. Lanza si la base no lo registra. */
  markUnknown(refundId: string, reason: string, details: Record<string, unknown>): Promise<void>;
  /** Estado del pago, para contarlo en la respuesta. */
  paymentStatus(): Promise<string>;
  /** La fila de la devolución tal como está registrada. */
  registered(refundId: string): Promise<RegisteredRefund | null>;
}

export interface RefundTarget {
  token: string;
  providerTransactionId: string;
  amount: number;
}

export interface RefundSettlement {
  confirmed: boolean;
  kind: string | null;
  refunded: number | null;
  details: Record<string, unknown>;
}

export interface RefundSettleResult {
  data: Record<string, unknown> | null;
  error: { message: string } | null;
}

export interface RegisteredRefund {
  status: string;
  kind: string | null;
  amount: number;
  failure_reason: string | null;
  unknown_reason: string | null;
}

/**
 * Reserva el envío, llama al banco una sola vez y registra lo que conteste.
 */
export async function dispatchRefund(
  book: RefundBook,
  provider: PaymentProvider,
  refundId: string,
): Promise<RefundOutcome> {
  // Solo quien reserva el envío llama al banco. Una petición repetida —el
  // mismo formulario enviado dos veces, a la vez o después— recibe la misma
  // fila y aquí se entera de que otra llamada ya la tiene.
  if (!(await book.claim(refundId))) return replayOutcome(book, refundId);

  if (!isReconcilable(provider)) {
    return settleFailed(book, refundId, "provider_without_refund_support");
  }

  const target = await book.target(refundId);
  if (!target) {
    return settleFailed(book, refundId, "missing_token");
  }

  let providerResult: ProviderRefundResult;
  try {
    providerResult = await provider.refundTransaction({
      providerTransactionId: target.providerTransactionId,
      token: target.token,
      amount: { amount: target.amount, currency: "CLP" },
    });
  } catch (error) {
    const verdict = classifyRefundError(error);
    paymentLog({
      operation: "refund",
      result: verdict.outcome === "REJECTED" ? "rejected" : "unknown",
      paymentId: book.paymentId,
      environment: provider.environment,
      reason: verdict.reason,
      errorCategory: errorCategory(error),
    });
    return verdict.outcome === "REJECTED"
      ? settleFailed(book, refundId, verdict.reason)
      : markUnknown(book, refundId, verdict.reason);
  }

  const verdict = classifyRefundResult(providerResult);
  const details = {
    authorization_code: providerResult.authorizationCode,
    authorization_date: providerResult.authorizationDate,
    nullified_amount: providerResult.refundedAmount,
    balance: providerResult.balance,
    response_code: providerResult.responseCode,
    raw: providerResult.raw,
  };

  if (verdict.outcome === "UNKNOWN") {
    paymentLog({
      operation: "refund",
      result: "unknown",
      paymentId: book.paymentId,
      environment: provider.environment,
      reason: verdict.reason,
    });
    return markUnknown(book, refundId, verdict.reason, details);
  }

  const confirmed = verdict.outcome === "CONFIRMED";
  const rejection = verdict.outcome === "REJECTED" ? verdict.reason : undefined;
  const { data: settled, error: settleError } = await book.settle(refundId, {
    confirmed,
    kind: confirmed ? providerResult.kind : null,
    refunded: confirmed ? providerResult.refundedAmount : null,
    details: { ...details, failure_reason: rejection ?? null },
  });
  if (settleError) {
    // El banco contestó y la base no lo pudo registrar. La devolución queda
    // pedida y enviada; la conciliación la pasará a «por confirmar» y la
    // cerrará con la consulta de estado. Repetirla ahora sería pedirla dos veces.
    paymentLog({
      operation: "refund",
      result: confirmed ? "confirmed_unrecorded" : "rejected_unrecorded",
      paymentId: book.paymentId,
      environment: provider.environment,
    });
    throw new Error(
      "El banco contestó, pero no pudimos registrar el resultado. La devolución queda por confirmar: no la repitas.",
    );
  }

  const row = settled ?? {};

  // Otra vía (la conciliación, o una persona) la cerró mientras el banco
  // contestaba. Lo que vale es lo registrado, no lo que se iba a registrar:
  // decir «confirmada» sobre una fila FAILED es justo lo que lleva a devolver
  // dos veces. Queda en el registro para revisarlo.
  if (row.outcome === "duplicate") {
    paymentLog({
      operation: "refund",
      result: `settled_elsewhere:${String(row.refund_status ?? "")}:provider_${verdict.outcome.toLowerCase()}`,
      paymentId: book.paymentId,
      environment: provider.environment,
    });
    return replayOutcome(book, refundId);
  }

  paymentLog({
    operation: "refund",
    result: confirmed ? `confirmed:${providerResult.kind}` : "rejected",
    paymentId: book.paymentId,
    environment: provider.environment,
  });

  return {
    refundId,
    state: confirmed ? "CONFIRMED" : "FAILED",
    confirmed,
    kind: providerResult.kind,
    refundedAmount: confirmed ? providerResult.refundedAmount : 0,
    paymentStatus: String(row.payment_status ?? ""),
    reason: rejection,
  };
}

/** Las devoluciones del cobro de un pago (`payment_refunds`). */
function paymentRefundBook(admin: SupabaseClient, request: RefundRequest): RefundBook {
  return {
    paymentId: request.paymentId,
    async claim(refundId) {
      const { data, error } = await admin.rpc("claim_payment_refund", { p_refund_id: refundId });
      if (error) throw new Error(error.message);
      return data === true;
    },
    async target() {
      const { data: tokenRow } = await admin
        .from("payments")
        .select("provider_token,provider_transaction_id")
        .eq("id", request.paymentId)
        .maybeSingle<{ provider_token: string | null; provider_transaction_id: string | null }>();
      if (!tokenRow?.provider_token) return null;
      return {
        token: tokenRow.provider_token,
        providerTransactionId: tokenRow.provider_transaction_id ?? tokenRow.provider_token,
        amount: request.amount,
      };
    },
    async settle(refundId, input) {
      const { data, error } = await admin.rpc("settle_payment_refund", {
        p_refund_id: refundId,
        p_confirmed: input.confirmed,
        p_kind: input.kind,
        p_refunded: input.refunded,
        p_details: input.details,
      });
      return { data: (data ?? null) as Record<string, unknown> | null, error };
    },
    async markUnknown(refundId, reason, details) {
      const { error } = await admin.rpc("mark_payment_refund_unknown", {
        p_refund_id: refundId,
        p_reason: reason,
        p_details: details,
      });
      if (error) throw new Error(error.message);
    },
    paymentStatus: () => paymentStatusOf(admin, request.paymentId),
    async registered(refundId) {
      const { data } = await admin
        .from("payment_refunds")
        .select("status,kind,amount,failure_reason,unknown_reason")
        .eq("id", refundId)
        .maybeSingle<RegisteredRefund>();
      return data ?? null;
    },
  };
}

/** Estado actual de un pago. */
export async function paymentStatusOf(admin: SupabaseClient, paymentId: string): Promise<string> {
  const { data } = await admin
    .from("payments")
    .select("status")
    .eq("id", paymentId)
    .maybeSingle<{ status: string }>();
  return data?.status ?? "";
}

/** Cierra como fallida una devolución que el banco no hizo. */
async function settleFailed(
  book: RefundBook,
  refundId: string,
  reason: string,
): Promise<RefundOutcome> {
  const { data, error } = await book.settle(refundId, {
    confirmed: false,
    kind: null,
    refunded: null,
    details: { failure_reason: reason },
  });
  if (error) throw new Error(error.message);
  return {
    refundId,
    state: "FAILED",
    confirmed: false,
    kind: "UNKNOWN",
    refundedAmount: 0,
    paymentStatus: String(data?.payment_status ?? ""),
    reason,
  };
}

/** Deja la devolución por confirmar: el banco pudo haberla hecho. */
async function markUnknown(
  book: RefundBook,
  refundId: string,
  reason: string,
  details: Record<string, unknown> = {},
): Promise<RefundOutcome> {
  await book.markUnknown(refundId, reason, details);
  return {
    refundId,
    state: "UNKNOWN",
    confirmed: false,
    kind: "UNKNOWN",
    refundedAmount: 0,
    paymentStatus: await book.paymentStatus(),
    reason,
  };
}

/** Lo que pasó con una petición que otra llamada ya envió al banco. */
async function replayOutcome(book: RefundBook, refundId: string): Promise<RefundOutcome> {
  const [refund, paymentStatus] = await Promise.all([
    book.registered(refundId),
    book.paymentStatus(),
  ]);

  const status = refund?.status ?? "REQUESTED";
  const state: RefundState =
    status === "CONFIRMED"
      ? "CONFIRMED"
      : status === "FAILED" || status === "CANCELLED"
        ? "FAILED"
        : status === "UNKNOWN"
          ? "UNKNOWN"
          : "IN_PROGRESS";

  return {
    refundId,
    state,
    confirmed: state === "CONFIRMED",
    kind: (refund?.kind as RefundOutcome["kind"] | null) ?? "UNKNOWN",
    refundedAmount: state === "CONFIRMED" ? Number(refund?.amount ?? 0) : 0,
    paymentStatus,
    reason:
      state === "FAILED"
        ? (refund?.failure_reason ?? undefined)
        : state === "UNKNOWN"
          ? (refund?.unknown_reason ?? undefined)
          : undefined,
    replayed: true,
  };
}
