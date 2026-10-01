import type { SupabaseClient } from "@supabase/supabase-js";

import { getPaymentProviderForExistingPayments } from "./index";
import { errorCategory, paymentLog } from "./logging";
import { isReconcilable, type PaymentProvider, type ProviderSnapshot } from "./provider";
import { TRANSBANK_STATUS } from "./transbank/mapping";

/**
 * Conciliación de devoluciones con resultado desconocido.
 *
 * Webpay Plus no tiene una consulta de devoluciones: `refund(token, importe)`
 * contesta una vez y, si esa respuesta se pierde, no hay forma de volver a
 * pedirla. Lo único que queda es `status(token)`, la misma consulta que usa la
 * conciliación de pagos, que describe la TRANSACCIÓN: su estado
 * (`AUTHORIZED`, `REVERSED`, `NULLIFIED`, `PARTIALLY_NULLIFIED`…), su importe
 * y, cuando se anuló en parte, el saldo (`balance`).
 *
 * De ahí solo se deduce lo que es inequívoco con lo que ya está registrado:
 *
 * · reversada, y lo pedido era el total sin nada devuelto antes → se hizo;
 * · anulada entera, y lo pedido completa el total → se hizo;
 * · anulada en parte, y el saldo cuadra con lo devuelto MÁS lo pedido → se
 *   hizo; si cuadra con lo devuelto SIN lo pedido → no se hizo;
 * · autorizada, sin nada anulado y sin devoluciones previas → no se hizo.
 *
 * «No se hizo» solo se concluye pasado `NOT_EXECUTED_AFTER_MINUTES` desde el
 * envío: antes, la petición podría seguir en curso del lado del banco. Todo lo
 * demás —un importe que no cuadra, un saldo que falta, un estado inesperado,
 * una transacción fuera de los 7 días en que Webpay contesta— se deja para
 * que una persona lo mire en el portal de Transbank y lo cierre desde
 * `/admin/pagos` (`resolve_unknown_refund`). Esta función anota por qué.
 *
 * Los tipos del SDK (`transbank-sdk` 6.1.1) declaran `status()` como
 * `Promise<any>`: no dicen qué campos trae la respuesta. Los que se usan aquí
 * son los que ya traduce `transbank/mapping.ts` —`status`, `amount`,
 * `balance`— y nada más. No se probó contra el ambiente de integración (ver
 * `docs/TRANSBANK.md` §12).
 */

/**
 * Una devolución enviada que sigue sin respuesta pasado esto ya no está en
 * vuelo. El SDK espera hasta 10 minutos por omisión; se deja margen.
 */
export const STALE_REQUEST_MINUTES = 15;

/** Antigüedad mínima del envío para concluir, por el estado, que NO se hizo. */
export const NOT_EXECUTED_AFTER_MINUTES = 30;

/** Lo registrado en la base sobre la devolución y su pago. */
export interface UnknownRefundFacts {
  /** Lo pedido en esta devolución. */
  refundAmount: number;
  /** Lo cobrado en el pago. */
  paymentAmount: number;
  /** Lo ya devuelto y confirmado en el pago, sin contar esta. */
  confirmedRefunded: number;
  /** Minutos desde que la devolución salió hacia el banco. */
  minutesSinceDispatch: number;
}

/** Lo que dice `status(token)`, con los campos de `ProviderSnapshot`. */
export interface ProviderTransactionView {
  status: string | null;
  amount: number | null;
  balance: number | null;
}

export type UnknownRefundDecision =
  | {
      outcome: "CONFIRMED";
      kind: "REVERSED" | "NULLIFIED";
      refundedAmount: number;
      reason: string;
    }
  | { outcome: "FAILED"; reason: string }
  | { outcome: "UNDECIDED"; reason: string };

function undecided(reason: string): UnknownRefundDecision {
  return { outcome: "UNDECIDED", reason };
}

/**
 * Decide, si se puede, qué pasó con una devolución por confirmar.
 *
 * Pura: sin red y sin base. Ante cualquier duda contesta `UNDECIDED`.
 */
export function decideUnknownRefund(
  facts: UnknownRefundFacts,
  tx: ProviderTransactionView,
): UnknownRefundDecision {
  const { refundAmount, paymentAmount, confirmedRefunded } = facts;

  // Si la transacción no es la que creemos, nada de lo que diga sirve.
  if (tx.amount === null) return undecided("status_without_amount");
  if (tx.amount !== paymentAmount) return undecided("status_amount_mismatch");

  const withThis = confirmedRefunded + refundAmount;
  const notExecuted = (): UnknownRefundDecision =>
    facts.minutesSinceDispatch >= NOT_EXECUTED_AFTER_MINUTES
      ? { outcome: "FAILED", reason: "not_executed_per_status" }
      : undecided("too_recent_to_rule_out");

  switch (tx.status) {
    case TRANSBANK_STATUS.REVERSED:
      // La reversa deshace la transacción entera: solo puede ser ESTA si era
      // por el total y no se había devuelto nada antes.
      return confirmedRefunded === 0 && refundAmount === paymentAmount
        ? { outcome: "CONFIRMED", kind: "REVERSED", refundedAmount: refundAmount, reason: "status_reversed" }
        : undecided("reversed_does_not_match");

    case TRANSBANK_STATUS.NULLIFIED:
      if (tx.balance !== null && tx.balance !== 0) return undecided("nullified_with_balance");
      return withThis === paymentAmount
        ? { outcome: "CONFIRMED", kind: "NULLIFIED", refundedAmount: refundAmount, reason: "status_nullified" }
        : undecided("nullified_does_not_match");

    case TRANSBANK_STATUS.PARTIALLY_NULLIFIED: {
      if (tx.balance === null) return undecided("partially_nullified_without_balance");
      const nullified = paymentAmount - tx.balance;
      if (nullified === withThis) {
        return {
          outcome: "CONFIRMED",
          kind: "NULLIFIED",
          refundedAmount: refundAmount,
          reason: "status_balance_includes_refund",
        };
      }
      if (nullified === confirmedRefunded) return notExecuted();
      return undecided("balance_does_not_match");
    }

    case TRANSBANK_STATUS.AUTHORIZED:
      // Autorizada y sin anular: si tampoco hay devoluciones previas, esta no
      // se hizo. Con un saldo menor que el total, algo se anuló y no cuadra.
      if (tx.balance !== null && tx.balance !== paymentAmount) {
        return undecided("authorized_with_balance");
      }
      return confirmedRefunded === 0 ? notExecuted() : undecided("authorized_with_confirmed_refunds");

    default:
      return undecided(`status_${(tx.status ?? "missing").toLowerCase()}`);
  }
}

/* --------------------------------------------------------------- la pasada */

export interface RefundReconcileOptions {
  /** Solo las devoluciones de este pago. Para «Consultar al proveedor». */
  paymentId?: string;
  /** Minutos sin movimiento antes de volver a mirar una devolución. */
  minAgeMinutes?: number;
  limit?: number;
}

export interface RefundReconcileResult {
  refundId: string;
  paymentId: string;
  outcome: "confirmed" | "failed" | "undecided" | "in_flight" | "unreachable" | "error";
  reason?: string;
}

export interface RefundReconcileSummary {
  examined: number;
  /** Cerradas como hechas o no hechas en esta pasada. */
  resolved: number;
  /** Siguen por confirmar: esperan a la siguiente pasada o a una persona. */
  undecided: number;
  results: RefundReconcileResult[];
}

interface PendingRefundRow {
  refund_id: string;
  payment_id: string;
  status: string;
  amount: number;
  requested_at: string;
  dispatched_at: string | null;
  provider: string;
  environment: string | null;
  payment_amount: number;
  refunded_amount: number;
}

const MINUTE = 60_000;

/**
 * Recorre las devoluciones abiertas y resuelve lo que se pueda.
 *
 * `admin` tiene que ser el cliente con la clave de servicio. Una fila que
 * falla no detiene la pasada: queda anotada y se sigue con la siguiente.
 */
export async function reconcileRefunds(
  admin: SupabaseClient,
  options: RefundReconcileOptions = {},
): Promise<RefundReconcileSummary> {
  const { data, error } = await admin.rpc("refunds_pending_reconciliation", {
    p_min_age_minutes: options.minAgeMinutes ?? 10,
    p_limit: options.limit ?? 50,
    p_payment_id: options.paymentId ?? null,
  });
  if (error) throw new Error(`No se pudo leer la cola de devoluciones: ${error.message}`);

  const rows = (data ?? []) as PendingRefundRow[];
  if (rows.length === 0) return { examined: 0, resolved: 0, undecided: 0, results: [] };

  // El proveedor se construye cuando una fila lo necesita, y si no se puede
  // construir (p. ej. Webpay productivo con un bloqueo de configuración), las
  // demás filas siguen: una pedida que nunca salió se cierra, y una colgada
  // pasa a «por confirmar», sin preguntar al banco. Antes, un proveedor que no
  // se construía dejaba toda la cola sin tocar, y una REQUESTED no la puede
  // cerrar una persona: el pago quedaba sin poder devolver.
  let provider: PaymentProvider | null | undefined;
  let providerFailure = "";
  const getProvider = (): PaymentProvider | null => {
    if (provider === undefined) {
      try {
        provider = getPaymentProviderForExistingPayments();
      } catch (failure) {
        provider = null;
        providerFailure = errorCategory(failure);
      }
    }
    return provider;
  };
  const results: RefundReconcileResult[] = [];

  for (const row of rows) {
    let result: RefundReconcileResult;
    try {
      result = await reconcileOne(admin, getProvider, () => providerFailure, row);
    } catch (failure) {
      result = {
        refundId: row.refund_id,
        paymentId: row.payment_id,
        outcome: "error",
        reason: errorCategory(failure),
      };
      // Que quede dicho en la devolución, y que la próxima pasada espere su
      // margen en vez de volver a preguntar a Webpay cada vez.
      if (row.status === "UNKNOWN") {
        await note(admin, row.refund_id, "reconcile_error").catch(() => undefined);
      }
    }
    results.push(result);
    paymentLog({
      operation: "reconcile",
      result: `refund:${result.outcome}`,
      paymentId: row.payment_id,
      reason: result.reason,
    });
  }

  const resolved = results.filter((r) => r.outcome === "confirmed" || r.outcome === "failed").length;
  const pending = results.filter((r) => r.outcome === "undecided" || r.outcome === "unreachable").length;
  return { examined: rows.length, resolved, undecided: pending, results };
}

async function reconcileOne(
  admin: SupabaseClient,
  getProvider: () => PaymentProvider | null,
  providerFailure: () => string,
  row: PendingRefundRow,
): Promise<RefundReconcileResult> {
  const base = { refundId: row.refund_id, paymentId: row.payment_id };
  const now = Date.now();

  if (row.status === "REQUESTED") {
    // Sin marca de envío, la petición no salió: se reserva antes de llamar al
    // banco, siempre. Pasado el margen, se cierra como no hecha.
    if (!row.dispatched_at) {
      if (now - new Date(row.requested_at).getTime() < STALE_REQUEST_MINUTES * MINUTE) {
        return { ...base, outcome: "in_flight" };
      }
      // La cola se leyó hace un instante: entre tanto, la misma petición
      // repetida desde el formulario pudo reservarla y estar llamando al banco.
      // Se reserva igual que lo haría ella; si la reserva es de otro, no se
      // toca. Cerrarla FAILED en ese cruce dejaba libre un saldo que el banco
      // sí devolvió.
      const { data: claimed, error: claimError } = await admin.rpc("claim_payment_refund", {
        p_refund_id: row.refund_id,
      });
      if (claimError) throw new Error(claimError.message);
      if (claimed !== true) return { ...base, outcome: "in_flight", reason: "claimed_elsewhere" };
      await settle(admin, row.refund_id, false, null, null, { failure_reason: "not_dispatched" });
      return { ...base, outcome: "failed", reason: "not_dispatched" };
    }
    // Enviada y sin respuesta registrada: puede seguir en curso o el proceso
    // pudo morir a mitad. Pasado el margen, ya no se espera: por confirmar.
    if (now - new Date(row.dispatched_at).getTime() < STALE_REQUEST_MINUTES * MINUTE) {
      return { ...base, outcome: "in_flight" };
    }
    await note(admin, row.refund_id, "stale_request");
  }

  const provider = getProvider();
  if (!provider) {
    const reason = `provider_unavailable:${providerFailure()}`;
    await note(admin, row.refund_id, reason);
    return { ...base, outcome: "unreachable", reason };
  }

  if (!isReconcilable(provider)) {
    await note(admin, row.refund_id, "provider_without_status");
    return { ...base, outcome: "undecided", reason: "provider_without_status" };
  }

  // Una devolución de integración no se pregunta jamás contra producción.
  if (row.environment && row.environment !== provider.environment) {
    const reason = `environment_${row.environment}_vs_${provider.environment}`;
    await note(admin, row.refund_id, reason);
    return { ...base, outcome: "undecided", reason };
  }

  const { data: tokenRow } = await admin
    .from("payments")
    .select("provider_token")
    .eq("id", row.payment_id)
    .maybeSingle<{ provider_token: string | null }>();
  if (!tokenRow?.provider_token) {
    await note(admin, row.refund_id, "missing_token");
    return { ...base, outcome: "undecided", reason: "missing_token" };
  }

  let snapshot: ProviderSnapshot;
  try {
    snapshot = await provider.inspect(tokenRow.provider_token);
  } catch (failure) {
    // Fuera de la ventana de 7 días Webpay ya no contesta, y eso no se
    // arregla esperando: la anotación le dice a quien mire que vaya al portal.
    const reason = `status_unavailable:${errorCategory(failure)}`;
    await note(admin, row.refund_id, reason);
    return { ...base, outcome: "unreachable", reason };
  }

  const dispatchedAt = new Date(row.dispatched_at ?? row.requested_at).getTime();
  const decision = decideUnknownRefund(
    {
      refundAmount: Number(row.amount),
      paymentAmount: Number(row.payment_amount),
      confirmedRefunded: Number(row.refunded_amount),
      minutesSinceDispatch: (now - dispatchedAt) / MINUTE,
    },
    { status: snapshot.providerStatus, amount: snapshot.amount, balance: snapshot.balance },
  );

  const evidence = {
    source: "reconcile",
    provider_status: snapshot.providerStatus,
    provider_amount: snapshot.amount,
    balance: snapshot.balance,
    decision: decision.reason,
  };

  if (decision.outcome === "CONFIRMED") {
    await settle(admin, row.refund_id, true, decision.kind, decision.refundedAmount, evidence);
    return { ...base, outcome: "confirmed", reason: decision.reason };
  }
  if (decision.outcome === "FAILED") {
    await settle(admin, row.refund_id, false, null, null, {
      ...evidence,
      failure_reason: decision.reason,
    });
    return { ...base, outcome: "failed", reason: decision.reason };
  }

  await note(admin, row.refund_id, decision.reason, evidence);
  return { ...base, outcome: "undecided", reason: decision.reason };
}

async function settle(
  admin: SupabaseClient,
  refundId: string,
  confirmed: boolean,
  kind: string | null,
  refunded: number | null,
  details: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.rpc("settle_payment_refund", {
    p_refund_id: refundId,
    p_confirmed: confirmed,
    p_kind: kind,
    p_refunded: refunded,
    p_details: details,
  });
  if (error) throw new Error(error.message);
}

/** La deja por confirmar, o anota por qué sigue así. */
async function note(
  admin: SupabaseClient,
  refundId: string,
  reason: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await admin.rpc("mark_payment_refund_unknown", {
    p_refund_id: refundId,
    p_reason: reason,
    p_details: details,
  });
  if (error) throw new Error(error.message);
}
