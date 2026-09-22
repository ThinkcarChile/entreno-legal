import type { SupabaseClient } from "@supabase/supabase-js";

import { paymentLog } from "./logging";
import { getPaymentProvider } from "./index";
import { applyProviderResult, type SettlementOutcome } from "./settle";
import { PAYMENT_COLUMNS, recordSnapshot, type PaymentRow } from "./checkout";
import { findMismatches } from "./transbank/mapping";
import { paymentFingerprintOf, paymentIdFromSessionId } from "./transbank/identifiers";
import { failureReasonFor, type ReturnFlow } from "./transbank/return-flow";
import { isReconcilable, type ProviderSnapshot } from "./provider";

/**
 * Qué hacer con un retorno de Webpay, decidido en un solo sitio.
 *
 * La ruta HTTP se limita a leer parámetros y redirigir; toda la decisión —a
 * quién pertenece el pago, si se confirma o solo se consulta, si el resultado
 * cuadra— vive aquí, para que se pueda probar sin un navegador y para que el
 * verificador recorra exactamente el mismo código que la aplicación.
 */
export type ReturnOutcome =
  | { kind: "SETTLED"; payment: PaymentRow; settlement: SettlementOutcome }
  | { kind: "REVIEW"; payment: PaymentRow; reason: string }
  | { kind: "ABANDONED"; payment: PaymentRow; reason: string }
  | { kind: "PENDING"; payment: PaymentRow; reason: string }
  | { kind: "ALREADY"; payment: PaymentRow }
  | { kind: "NOT_FOUND"; reason: string }
  | { kind: "FORBIDDEN"; reason: string };

/**
 * Encuentra el pago del retorno.
 *
 * Tres vías, en orden de fiabilidad: el token (identifica la transacción), el
 * `session_id` (lleva dentro el identificador del pago) y el `buy_order` (lleva
 * su huella). Las dos últimas son las únicas disponibles cuando Webpay devuelve
 * sin token, que es justo el caso de tiempo agotado.
 */
export async function findPaymentForReturn(
  admin: SupabaseClient,
  flow: ReturnFlow,
): Promise<PaymentRow | null> {
  const byToken =
    flow.kind === "NORMAL" || flow.kind === "ABORTED"
      ? flow.token
      : flow.kind === "CONFLICTED"
        ? flow.abortedToken
        : null;

  if (byToken) {
    const { data } = await admin
      .from("payments")
      .select(PAYMENT_COLUMNS)
      .eq("provider_token", byToken)
      .maybeSingle<PaymentRow>();
    if (data) return data;
  }

  const sessionId =
    flow.kind === "TIMEOUT" || flow.kind === "ABORTED" || flow.kind === "CONFLICTED"
      ? flow.sessionId
      : null;

  if (sessionId) {
    const { data } = await admin
      .from("payments")
      .select(PAYMENT_COLUMNS)
      .eq("session_id", sessionId)
      .maybeSingle<PaymentRow>();
    if (data) return data;

    // El `session_id` lleva dentro el UUID del pago: si la columna no coincide
    // —un intento antiguo, una migración— todavía se puede resolver.
    const paymentId = paymentIdFromSessionId(sessionId);
    if (paymentId) {
      const { data: byId } = await admin
        .from("payments")
        .select(PAYMENT_COLUMNS)
        .eq("id", paymentId)
        .maybeSingle<PaymentRow>();
      if (byId) return byId;
    }
  }

  const buyOrder =
    flow.kind === "TIMEOUT" || flow.kind === "ABORTED" || flow.kind === "CONFLICTED"
      ? flow.buyOrder
      : null;

  if (buyOrder) {
    const { data } = await admin
      .from("payments")
      .select(PAYMENT_COLUMNS)
      .eq("buy_order", buyOrder)
      .maybeSingle<PaymentRow>();
    if (data) return data;

    const fingerprint = paymentFingerprintOf(buyOrder);
    if (fingerprint) {
      const { data: byFingerprint } = await admin
        .from("payments")
        .select(PAYMENT_COLUMNS)
        .like("buy_order", `HTF-${fingerprint}-%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<PaymentRow>();
      if (byFingerprint) return byFingerprint;
    }
  }

  return null;
}

/**
 * Resuelve el retorno.
 *
 * `viewerId` es quien volvió del formulario. Un pago solo lo resuelve su dueño:
 * un retorno que llega con la sesión de otra persona no asienta nada.
 */
export async function handleReturn(
  admin: SupabaseClient,
  flow: ReturnFlow,
  viewerId: string,
): Promise<ReturnOutcome> {
  const provider = getPaymentProvider();
  const payment = await findPaymentForReturn(admin, flow);

  if (!payment) {
    paymentLog({ operation: "return", result: "not_found", flow: flow.kind });
    return { kind: "NOT_FOUND", reason: "no se encontró el pago del retorno" };
  }
  if (payment.client_id !== viewerId) {
    paymentLog({
      operation: "return",
      result: "forbidden",
      paymentId: payment.id,
      flow: flow.kind,
    });
    return { kind: "FORBIDDEN", reason: "el pago no pertenece a quien volvió" };
  }

  // Ya resuelto: recargar la página de retorno no vuelve a llamar al banco.
  if (
    payment.status === "PAID" ||
    payment.status === "UNDER_REVIEW" ||
    payment.status === "REFUNDED" ||
    payment.status === "PARTIALLY_REFUNDED"
  ) {
    paymentLog({
      operation: "return",
      result: "already_settled",
      paymentId: payment.id,
      flow: flow.kind,
    });
    return { kind: "ALREADY", payment };
  }

  /* ---------------------------------------------------------- sin cobro --- */

  // Tres de los cuatro flujos NO confirman. En el flujo con parámetros
  // contradictorios hay un `token_ws` que invitaría a confirmar junto a un
  // `TBK_TOKEN` que dice que algo terminó mal: no se elige por gusto, se
  // consulta el estado, que no depende de lo que traiga la URL.
  if (flow.kind !== "NORMAL") {
    const reason = failureReasonFor(flow) ?? "unknown_return";
    const token = flow.kind === "TIMEOUT" ? null : flow.kind === "UNKNOWN" ? null : flow.token;

    // Con token se puede preguntar. Puede haber una autorización de verdad
    // detrás de un retorno raro, y darla por perdida sería perder dinero.
    if (token && isReconcilable(provider)) {
      const snapshot = await provider.inspect(token);
      await recordSnapshot(admin, payment.id, provider.id, snapshot);

      if (snapshot.authorized) {
        return settleFromSnapshot(admin, payment, provider.id, snapshot, flow.kind);
      }
    }

    const { error } = await admin.rpc("record_payment_abandonment", {
      p_payment_id: payment.id,
      p_provider: provider.id,
      p_failure_reason: reason,
      p_details: { flow: flow.kind },
    });
    if (error) throw new Error(`No se pudo registrar el retorno: ${error.message}`);

    paymentLog({
      operation: "return",
      result: reason,
      paymentId: payment.id,
      flow: flow.kind,
    });
    return { kind: "ABANDONED", payment, reason };
  }

  /* ------------------------------------------------------- flujo normal --- */

  const result = await provider.confirmPayment({ token: flow.token });
  await admin
    .from("payments")
    .update({ committed_at: new Date().toISOString() })
    .eq("id", payment.id);

  if (result.snapshot) {
    await recordSnapshot(admin, payment.id, provider.id, result.snapshot);
    const problems = findMismatches(
      {
        vci: result.snapshot.vci,
        amount: result.snapshot.amount,
        status: result.snapshot.providerStatus,
        buyOrder: result.snapshot.buyOrder,
        sessionId: result.snapshot.sessionId,
        cardLastDigits: result.snapshot.cardLastDigits,
        accountingDate: result.snapshot.accountingDate,
        transactionDate: result.snapshot.transactionDate,
        authorizationCode: result.snapshot.authorizationCode,
        paymentTypeCode: result.snapshot.paymentTypeCode,
        responseCode: result.snapshot.responseCode,
        installmentsAmount: result.snapshot.installmentsAmount,
        installmentsNumber: result.snapshot.installmentsNumber,
        balance: result.snapshot.balance,
      },
      {
        amount: payment.amount,
        buyOrder: payment.buy_order ?? "",
        sessionId: payment.session_id ?? "",
      },
    );

    // Autorizado pero inconsistente: ni se habilita el trabajo ni se crea pago
    // al trabajador. Queda en revisión con el motivo concreto.
    if (result.snapshot.authorized && problems.length > 0) {
      return underReview(admin, payment, provider.id, result.snapshot, problems.join(","));
    }
  }

  const settlement = await applyProviderResult(admin, payment.id, provider.id, result);

  paymentLog({
    operation: "commit",
    result: settlement.paymentStatus,
    paymentId: payment.id,
    flow: flow.kind,
    duplicate: settlement.outcome === "duplicate",
  });

  if (settlement.paymentStatus === "UNDER_REVIEW") {
    return { kind: "REVIEW", payment, reason: settlement.reviewReason ?? "under_review" };
  }
  return { kind: "SETTLED", payment, settlement };
}

/**
 * Asienta una autorización descubierta por `status` y no por `commit`.
 *
 * Pasa por la MISMA función de liquidación: no hay una vía «rápida» que salte
 * los invariantes porque el dinero se encontró por otro camino.
 */
async function settleFromSnapshot(
  admin: SupabaseClient,
  payment: PaymentRow,
  providerId: string,
  snapshot: ProviderSnapshot,
  flowKind: string,
): Promise<ReturnOutcome> {
  const problems = findMismatches(
    {
      vci: snapshot.vci,
      amount: snapshot.amount,
      status: snapshot.providerStatus,
      buyOrder: snapshot.buyOrder,
      sessionId: snapshot.sessionId,
      cardLastDigits: snapshot.cardLastDigits,
      accountingDate: snapshot.accountingDate,
      transactionDate: snapshot.transactionDate,
      authorizationCode: snapshot.authorizationCode,
      paymentTypeCode: snapshot.paymentTypeCode,
      responseCode: snapshot.responseCode,
      installmentsAmount: snapshot.installmentsAmount,
      installmentsNumber: snapshot.installmentsNumber,
      balance: snapshot.balance,
    },
    {
      amount: payment.amount,
      buyOrder: payment.buy_order ?? "",
      sessionId: payment.session_id ?? "",
    },
  );

  if (problems.length > 0) {
    return underReview(admin, payment, providerId, snapshot, problems.join(","));
  }

  const settlement = await applyProviderResult(admin, payment.id, providerId, {
    providerTransactionId: snapshot.token,
    // Mismo hecho financiero que un commit del mismo token: misma clave.
    providerEventId: `commit:${snapshot.token}`,
    status: "PAID",
    amount: { amount: snapshot.amount ?? payment.amount, currency: "CLP" },
    authorizationCode: snapshot.authorizationCode,
    cardLastDigits: snapshot.cardLastDigits,
    paymentTypeCode: snapshot.paymentTypeCode,
    installments: snapshot.installmentsNumber,
    transactionDate: snapshot.transactionDate,
    raw: snapshot.raw,
  });

  paymentLog({
    operation: "status",
    result: `recovered:${settlement.paymentStatus}`,
    paymentId: payment.id,
    flow: flowKind,
  });

  if (settlement.paymentStatus === "UNDER_REVIEW") {
    return { kind: "REVIEW", payment, reason: settlement.reviewReason ?? "under_review" };
  }
  return { kind: "SETTLED", payment, settlement };
}

/**
 * Autorizado pero con algo que no cuadra.
 *
 * El dinero se recibió, así que no se puede tratar como un fallo; y no cuadra,
 * así que no puede habilitar nada. Se registra el evento del proveedor —para
 * que quede la huella— y el pago queda en revisión con el motivo exacto.
 */
async function underReview(
  admin: SupabaseClient,
  payment: PaymentRow,
  providerId: string,
  snapshot: ProviderSnapshot,
  reason: string,
): Promise<ReturnOutcome> {
  const { error } = await admin.rpc("confirm_payment_result", {
    p_payment_id: payment.id,
    p_provider: providerId,
    p_provider_event_id: `commit:${snapshot.token}`,
    p_result: "PAID",
    // Un importe que no coincide hace que la propia función marque revisión.
    // Si el descuadre es de otra cosa, se fuerza aquí con el motivo.
    p_amount: snapshot.amount,
    p_details: {
      authorization_code: snapshot.authorizationCode,
      card_last_digits: snapshot.cardLastDigits,
      payment_type_code: snapshot.paymentTypeCode,
      installments: snapshot.installmentsNumber,
      transaction_date: snapshot.transactionDate,
      raw: snapshot.raw,
      mismatch: reason,
    },
  });
  if (error) throw new Error(`No se pudo registrar el pago inconsistente: ${error.message}`);

  await admin
    .from("payments")
    .update({ status: "UNDER_REVIEW", review_reason: reason })
    .eq("id", payment.id)
    .in("status", ["PAID", "AUTHORIZED", "CREATED", "PENDING"]);

  paymentLog({
    operation: "commit",
    result: "under_review",
    paymentId: payment.id,
    reason,
  });

  return { kind: "REVIEW", payment, reason };
}
