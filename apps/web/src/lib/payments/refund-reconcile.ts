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
 * Vale igual para la devolución de un cobro duplicado (la de un INTENTO,
 * `payment_attempt_refunds`): se consulta la transacción de ese intento, con
 * su token, y se decide con las mismas reglas (`reconcileAttemptRefunds`).
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
  /** El intento cuyo cobro se devuelve, en una devolución de cobro duplicado. */
  attemptId?: string;
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

/** Una devolución abierta, con lo que hace falta para decidir sobre ella. */
interface PendingRefund {
  refundId: string;
  paymentId: string;
  attemptId?: string;
  status: string;
  amount: number;
  requestedAt: string;
  dispatchedAt: string | null;
  environment: string | null;
  /** Importe de la transacción que se devuelve: la del pago, o la del intento. */
  transactionAmount: number;
  /** Lo ya devuelto y confirmado de esa transacción, sin contar esta. */
  refundedAmount: number;
}

/**
 * Lo que cambia entre conciliar las devoluciones del cobro de un PAGO y las
 * del cobro de un INTENTO (un cobro duplicado, `payment_attempt_refunds`): de
 * qué cola salen, con qué funciones se reservan, se cierran o se anotan, y de
 * dónde sale el token. La decisión —`decideUnknownRefund` y los márgenes— es la
 * misma. Cada una llama a las funciones por su nombre escrito, para que
 * `check-db-contract.sh` las encuentre.
 */
interface RefundLedger {
  /** Prefijo en el registro. */
  label: string;
  queue(admin: SupabaseClient, options: RefundReconcileOptions): Promise<PendingRefund[]>;
  claim(admin: SupabaseClient, refundId: string): Promise<boolean>;
  settle(
    admin: SupabaseClient,
    refundId: string,
    confirmed: boolean,
    kind: string | null,
    refunded: number | null,
    details: Record<string, unknown>,
  ): Promise<void>;
  /** La deja por confirmar, o anota por qué sigue así. */
  note(
    admin: SupabaseClient,
    refundId: string,
    reason: string,
    details?: Record<string, unknown>,
  ): Promise<void>;
  token(admin: SupabaseClient, row: PendingRefund): Promise<string | null>;
}

interface PaymentRefundRow {
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

interface AttemptRefundRow {
  refund_id: string;
  attempt_id: string;
  payment_id: string;
  status: string;
  amount: number;
  requested_at: string;
  dispatched_at: string | null;
  provider: string;
  environment: string | null;
  transaction_amount: number;
  refunded_amount: number;
}

function failIf(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

/** Las devoluciones del cobro de un pago (`payment_refunds`). */
const PAYMENT_REFUNDS: RefundLedger = {
  label: "refund",
  async queue(admin, options) {
    const { data, error } = await admin.rpc("refunds_pending_reconciliation", {
      p_min_age_minutes: options.minAgeMinutes ?? 10,
      p_limit: options.limit ?? 50,
      p_payment_id: options.paymentId ?? null,
    });
    if (error) throw new Error(`No se pudo leer la cola de devoluciones: ${error.message}`);
    return ((data ?? []) as PaymentRefundRow[]).map((row) => ({
      refundId: row.refund_id,
      paymentId: row.payment_id,
      status: row.status,
      amount: Number(row.amount),
      requestedAt: row.requested_at,
      dispatchedAt: row.dispatched_at,
      environment: row.environment,
      transactionAmount: Number(row.payment_amount),
      refundedAmount: Number(row.refunded_amount),
    }));
  },
  async claim(admin, refundId) {
    const { data, error } = await admin.rpc("claim_payment_refund", { p_refund_id: refundId });
    failIf(error);
    return data === true;
  },
  async settle(admin, refundId, confirmed, kind, refunded, details) {
    const { error } = await admin.rpc("settle_payment_refund", {
      p_refund_id: refundId,
      p_confirmed: confirmed,
      p_kind: kind,
      p_refunded: refunded,
      p_details: details,
    });
    failIf(error);
  },
  async note(admin, refundId, reason, details = {}) {
    const { error } = await admin.rpc("mark_payment_refund_unknown", {
      p_refund_id: refundId,
      p_reason: reason,
      p_details: details,
    });
    failIf(error);
  },
  async token(admin, row) {
    const { data } = await admin
      .from("payments")
      .select("provider_token")
      .eq("id", row.paymentId)
      .maybeSingle<{ provider_token: string | null }>();
    return data?.provider_token ?? null;
  },
};

/** Las devoluciones del cobro de un intento (`payment_attempt_refunds`). */
const ATTEMPT_REFUNDS: RefundLedger = {
  label: "attempt_refund",
  async queue(admin, options) {
    const { data, error } = await admin.rpc("attempt_refunds_pending_reconciliation", {
      p_min_age_minutes: options.minAgeMinutes ?? 10,
      p_limit: options.limit ?? 50,
      p_payment_id: options.paymentId ?? null,
    });
    if (error) {
      throw new Error(`No se pudo leer la cola de devoluciones de cobros duplicados: ${error.message}`);
    }
    return ((data ?? []) as AttemptRefundRow[]).map((row) => ({
      refundId: row.refund_id,
      paymentId: row.payment_id,
      attemptId: row.attempt_id,
      status: row.status,
      amount: Number(row.amount),
      requestedAt: row.requested_at,
      dispatchedAt: row.dispatched_at,
      environment: row.environment,
      transactionAmount: Number(row.transaction_amount),
      refundedAmount: Number(row.refunded_amount),
    }));
  },
  async claim(admin, refundId) {
    const { data, error } = await admin.rpc("claim_attempt_refund", { p_refund_id: refundId });
    failIf(error);
    return data === true;
  },
  async settle(admin, refundId, confirmed, kind, refunded, details) {
    const { error } = await admin.rpc("settle_attempt_refund", {
      p_refund_id: refundId,
      p_confirmed: confirmed,
      p_kind: kind,
      p_refunded: refunded,
      p_details: details,
    });
    failIf(error);
  },
  async note(admin, refundId, reason, details = {}) {
    const { error } = await admin.rpc("mark_attempt_refund_unknown", {
      p_refund_id: refundId,
      p_reason: reason,
      p_details: details,
    });
    failIf(error);
  },
  // El token del INTENTO, no el del pago: el del pago es el del cobro bueno.
  async token(admin, row) {
    if (!row.attemptId) return null;
    const { data } = await admin
      .from("payment_attempts")
      .select("provider_token")
      .eq("id", row.attemptId)
      .maybeSingle<{ provider_token: string | null }>();
    return data?.provider_token ?? null;
  },
};

const MINUTE = 60_000;

/**
 * Recorre las devoluciones abiertas del cobro de los pagos y resuelve lo que
 * se pueda.
 *
 * `admin` tiene que ser el cliente con la clave de servicio. Una fila que
 * falla no detiene la pasada: queda anotada y se sigue con la siguiente.
 */
export function reconcileRefunds(
  admin: SupabaseClient,
  options: RefundReconcileOptions = {},
): Promise<RefundReconcileSummary> {
  return reconcileLedger(admin, PAYMENT_REFUNDS, options);
}

/**
 * Lo mismo con las devoluciones de cobros duplicados: se consulta la
 * transacción del INTENTO, con su token, y se decide con las mismas reglas.
 * El cobro de un intento se devuelve siempre entero, así que lo «ya devuelto»
 * de esa transacción es cero.
 */
export function reconcileAttemptRefunds(
  admin: SupabaseClient,
  options: RefundReconcileOptions = {},
): Promise<RefundReconcileSummary> {
  return reconcileLedger(admin, ATTEMPT_REFUNDS, options);
}

async function reconcileLedger(
  admin: SupabaseClient,
  ledger: RefundLedger,
  options: RefundReconcileOptions,
): Promise<RefundReconcileSummary> {
  const rows = await ledger.queue(admin, options);
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
      result = await reconcileOne(admin, ledger, getProvider, () => providerFailure, row);
    } catch (failure) {
      result = {
        ...baseOf(row),
        outcome: "error",
        reason: errorCategory(failure),
      };
      // Que quede dicho en la devolución, y que la próxima pasada espere su
      // margen en vez de volver a preguntar a Webpay cada vez.
      if (row.status === "UNKNOWN") {
        await ledger.note(admin, row.refundId, "reconcile_error").catch(() => undefined);
      }
    }
    results.push(result);
    paymentLog({
      operation: "reconcile",
      result: `${ledger.label}:${result.outcome}`,
      paymentId: row.paymentId,
      reason: result.reason,
    });
  }

  const resolved = results.filter((r) => r.outcome === "confirmed" || r.outcome === "failed").length;
  const pending = results.filter((r) => r.outcome === "undecided" || r.outcome === "unreachable").length;
  return { examined: rows.length, resolved, undecided: pending, results };
}

function baseOf(row: PendingRefund): Pick<RefundReconcileResult, "refundId" | "paymentId" | "attemptId"> {
  return row.attemptId
    ? { refundId: row.refundId, paymentId: row.paymentId, attemptId: row.attemptId }
    : { refundId: row.refundId, paymentId: row.paymentId };
}

async function reconcileOne(
  admin: SupabaseClient,
  ledger: RefundLedger,
  getProvider: () => PaymentProvider | null,
  providerFailure: () => string,
  row: PendingRefund,
): Promise<RefundReconcileResult> {
  const base = baseOf(row);
  const now = Date.now();

  if (row.status === "REQUESTED") {
    // Sin marca de envío, la petición no salió: se reserva antes de llamar al
    // banco, siempre. Pasado el margen, se cierra como no hecha.
    if (!row.dispatchedAt) {
      if (now - new Date(row.requestedAt).getTime() < STALE_REQUEST_MINUTES * MINUTE) {
        return { ...base, outcome: "in_flight" };
      }
      // La cola se leyó hace un instante: entre tanto, la misma petición
      // repetida desde el formulario pudo reservarla y estar llamando al banco.
      // Se reserva igual que lo haría ella; si la reserva es de otro, no se
      // toca. Cerrarla FAILED en ese cruce dejaba libre un saldo que el banco
      // sí devolvió.
      if (!(await ledger.claim(admin, row.refundId))) {
        return { ...base, outcome: "in_flight", reason: "claimed_elsewhere" };
      }
      await ledger.settle(admin, row.refundId, false, null, null, { failure_reason: "not_dispatched" });
      return { ...base, outcome: "failed", reason: "not_dispatched" };
    }
    // Enviada y sin respuesta registrada: puede seguir en curso o el proceso
    // pudo morir a mitad. Pasado el margen, ya no se espera: por confirmar.
    if (now - new Date(row.dispatchedAt).getTime() < STALE_REQUEST_MINUTES * MINUTE) {
      return { ...base, outcome: "in_flight" };
    }
    await ledger.note(admin, row.refundId, "stale_request");
  }

  const provider = getProvider();
  if (!provider) {
    const reason = `provider_unavailable:${providerFailure()}`;
    await ledger.note(admin, row.refundId, reason);
    return { ...base, outcome: "unreachable", reason };
  }

  if (!isReconcilable(provider)) {
    await ledger.note(admin, row.refundId, "provider_without_status");
    return { ...base, outcome: "undecided", reason: "provider_without_status" };
  }

  // Una devolución de integración no se pregunta jamás contra producción.
  if (row.environment && row.environment !== provider.environment) {
    const reason = `environment_${row.environment}_vs_${provider.environment}`;
    await ledger.note(admin, row.refundId, reason);
    return { ...base, outcome: "undecided", reason };
  }

  const token = await ledger.token(admin, row);
  if (!token) {
    await ledger.note(admin, row.refundId, "missing_token");
    return { ...base, outcome: "undecided", reason: "missing_token" };
  }

  let snapshot: ProviderSnapshot;
  try {
    snapshot = await provider.inspect(token);
  } catch (failure) {
    // Fuera de la ventana de 7 días Webpay ya no contesta, y eso no se
    // arregla esperando: la anotación le dice a quien mire que vaya al portal.
    const reason = `status_unavailable:${errorCategory(failure)}`;
    await ledger.note(admin, row.refundId, reason);
    return { ...base, outcome: "unreachable", reason };
  }

  const dispatchedAt = new Date(row.dispatchedAt ?? row.requestedAt).getTime();
  const decision = decideUnknownRefund(
    {
      refundAmount: row.amount,
      paymentAmount: row.transactionAmount,
      confirmedRefunded: row.refundedAmount,
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
    await ledger.settle(admin, row.refundId, true, decision.kind, decision.refundedAmount, evidence);
    return { ...base, outcome: "confirmed", reason: decision.reason };
  }
  if (decision.outcome === "FAILED") {
    await ledger.settle(admin, row.refundId, false, null, null, {
      ...evidence,
      failure_reason: decision.reason,
    });
    return { ...base, outcome: "failed", reason: decision.reason };
  }

  await ledger.note(admin, row.refundId, decision.reason, evidence);
  return { ...base, outcome: "undecided", reason: decision.reason };
}
