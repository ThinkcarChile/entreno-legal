import type { SupabaseClient } from "@supabase/supabase-js";

import { errorCategory, paymentLog } from "./logging";
import { getPaymentProviderForExistingPayments } from "./index";
import { applyProviderResult, type SettlementOutcome } from "./settle";
import { PAYMENT_COLUMNS, recordSnapshot, type PaymentRow } from "./checkout";
import { ATTEMPT_COLUMNS, ATTEMPT_STATUSES_WITH_MONEY, type AttemptRow } from "./attempts";
import { findMismatches } from "./transbank/mapping";
import { paymentFingerprintOf, paymentIdFromSessionId } from "./transbank/identifiers";
import { failureReasonFor, tokenForStatus, type ReturnFlow } from "./transbank/return-flow";
import {
  isReconcilable,
  type ConfirmPaymentResult,
  type PaymentProvider,
  type ProviderSnapshot,
} from "./provider";

/**
 * Qué hacer con un retorno de Webpay, decidido en un solo sitio.
 *
 * La ruta HTTP se limita a leer parámetros y redirigir; toda la decisión —a
 * quién pertenece el pago, de qué intento es el retorno, si se confirma o solo
 * se consulta, si el resultado cuadra— vive aquí, para que se pueda probar sin
 * un navegador y para que la conciliación recorra exactamente el mismo código
 * que la aplicación.
 *
 * Un pago puede tener varios intentos (`payment_attempts`): el cliente abandona
 * el formulario y vuelve a pagar, o abre Webpay en dos pestañas. El pago guarda
 * el token del vigente y el historial guarda todos. Un retorno se resuelve
 * sobre SU intento:
 *
 * · un retorno sin cobro de un intento anterior cierra ese intento, no el pago;
 * · un cobro de un intento anterior se confirma igual que cualquier otro, y si
 *   el pago ya tenía el dinero de otro intento la base lo registra como cobro
 *   duplicado, a la vista de administración.
 */
export type ReturnOutcome =
  | { kind: "SETTLED"; payment: PaymentRow; settlement: SettlementOutcome }
  | { kind: "REVIEW"; payment: PaymentRow; reason: string }
  | { kind: "DOUBLE_CHARGE"; payment: PaymentRow; reason: string }
  | { kind: "ABANDONED"; payment: PaymentRow; reason: string }
  | { kind: "PENDING"; payment: PaymentRow; reason: string }
  | { kind: "ALREADY"; payment: PaymentRow }
  | { kind: "NOT_FOUND"; reason: string }
  | { kind: "FORBIDDEN"; reason: string };

/** El pago de un retorno y el intento al que pertenece. */
export interface ReturnTarget {
  payment: PaymentRow;
  /** El intento que trae el retorno, si se pudo identificar. */
  attempt: AttemptRow | null;
  /** ¿Es el intento vigente del pago? Solo ese puede cerrar el pago sin cobro. */
  current: boolean;
  /**
   * El token del retorno, solo si es de este pago (el vigente o uno del
   * historial). Un token que no conocemos no se confirma ni se consulta.
   */
  token: string | null;
}

/** Estados del pago que ya tienen un resultado con dinero de por medio. */
const PAYMENT_STATUSES_WITH_MONEY = ["PAID", "UNDER_REVIEW", "REFUNDED", "PARTIALLY_REFUNDED"];

/* ------------------------------------------------------------- búsqueda --- */

async function paymentBy(
  admin: SupabaseClient,
  column: "provider_token" | "buy_order" | "session_id" | "id",
  value: string,
): Promise<PaymentRow | null> {
  const { data } = await admin
    .from("payments")
    .select(PAYMENT_COLUMNS)
    .eq(column, value)
    .maybeSingle<PaymentRow>();
  return data ?? null;
}

async function attemptBy(
  admin: SupabaseClient,
  column: "provider_token" | "buy_order",
  value: string,
): Promise<AttemptRow | null> {
  const { data } = await admin
    .from("payment_attempts")
    .select(ATTEMPT_COLUMNS)
    .eq(column, value)
    .maybeSingle<AttemptRow>();
  return data ?? null;
}

/** El intento vigente: el que lleva la orden de compra del pago. */
async function currentAttemptOf(
  admin: SupabaseClient,
  payment: PaymentRow,
): Promise<AttemptRow | null> {
  if (!payment.buy_order) return null;
  const { data } = await admin
    .from("payment_attempts")
    .select(ATTEMPT_COLUMNS)
    .eq("payment_id", payment.id)
    .eq("buy_order", payment.buy_order)
    .maybeSingle<AttemptRow>();
  return data ?? null;
}

/**
 * El pago y el intento de un token: primero el del pago (el vigente), después
 * el historial. Es lo que antes faltaba: el token de un intento anterior ya no
 * estaba en ninguna parte.
 */
export async function findTargetByToken(
  admin: SupabaseClient,
  token: string,
): Promise<ReturnTarget | null> {
  const payment = await paymentBy(admin, "provider_token", token);
  if (payment) {
    const attempt =
      (await attemptBy(admin, "provider_token", token)) ?? (await currentAttemptOf(admin, payment));
    return { payment, attempt, current: true, token };
  }

  const attempt = await attemptBy(admin, "provider_token", token);
  if (!attempt) return null;
  const owner = await paymentBy(admin, "id", attempt.payment_id);
  if (!owner) return null;
  return { payment: owner, attempt, current: owner.buy_order === attempt.buy_order, token };
}

/**
 * Encuentra el pago y el intento del retorno.
 *
 * Tres vías, en orden de fiabilidad: el token (identifica la transacción), el
 * `buy_order` (identifica el intento: cada uno estrena el suyo) y el
 * `session_id` (identifica el pago, pero es el mismo en todos sus intentos).
 * Las dos últimas son las únicas disponibles cuando Webpay devuelve sin token,
 * que es justo el caso de tiempo agotado.
 */
export async function findReturnTarget(
  admin: SupabaseClient,
  flow: ReturnFlow,
): Promise<ReturnTarget | null> {
  const token = tokenForStatus(flow);
  if (token) {
    const byToken = await findTargetByToken(admin, token);
    if (byToken) return byToken;
  }

  const withoutToken =
    flow.kind === "TIMEOUT" || flow.kind === "ABORTED" || flow.kind === "CONFLICTED";
  const buyOrder = withoutToken ? flow.buyOrder : null;
  const sessionId = withoutToken ? flow.sessionId : null;

  if (buyOrder) {
    const payment = await paymentBy(admin, "buy_order", buyOrder);
    if (payment) {
      return { payment, attempt: await currentAttemptOf(admin, payment), current: true, token: null };
    }
    const attempt = await attemptBy(admin, "buy_order", buyOrder);
    if (attempt) {
      const owner = await paymentBy(admin, "id", attempt.payment_id);
      if (owner) {
        return { payment: owner, attempt, current: owner.buy_order === attempt.buy_order, token: null };
      }
    }
  }

  let payment: PaymentRow | null = null;
  if (sessionId) {
    payment = await paymentBy(admin, "session_id", sessionId);
    // El `session_id` lleva dentro el UUID del pago: si la columna no coincide
    // —un intento antiguo, una migración— todavía se puede resolver.
    const paymentId = payment ? null : paymentIdFromSessionId(sessionId);
    if (paymentId) payment = await paymentBy(admin, "id", paymentId);
  }
  if (!payment && buyOrder) {
    const fingerprint = paymentFingerprintOf(buyOrder);
    if (fingerprint) {
      const { data } = await admin
        .from("payments")
        .select(PAYMENT_COLUMNS)
        .like("buy_order", `HTF-${fingerprint}-%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<PaymentRow>();
      payment = data ?? null;
    }
  }
  if (!payment) return null;

  // Con una orden de compra que no es la del pago ni está en su historial, el
  // retorno es de un intento que no conocemos: no es el vigente.
  if (buyOrder) return { payment, attempt: null, current: false, token: null };

  // Solo la sesión, que es la misma en todos los intentos. Si el pago tuvo uno
  // solo, el retorno es de ese; si tuvo varios, no se adivina cuál.
  if (payment.attempt <= 1) {
    return { payment, attempt: await currentAttemptOf(admin, payment), current: true, token: null };
  }
  return { payment, attempt: null, current: false, token: null };
}

/* ------------------------------------------------------------- el retorno --- */

/**
 * Resuelve el retorno.
 *
 * `viewerId` es quien volvió del formulario, o `null` cuando no hay sesión o
 * cuando llama la conciliación.
 *
 * Con `null` el pago se resuelve igual: la prueba de que el retorno es
 * legítimo es el token de Transbank —un secreto de 64 caracteres que solo
 * conoce quien pasó por el formulario—, y confirmar solo puede beneficiar a
 * quien pagó. Confirmar siempre es correcto: si no hacía falta, un segundo
 * `commit` contesta 4xx y se lee el estado.
 *
 * Con un `viewerId` que NO es el dueño se responde FORBIDDEN sin tocar nada:
 * la ruta llama sin identidad para resolver y decide la redirección por su
 * cuenta, sin revelar a un tercero el estado de un pago ajeno.
 */
export async function handleReturn(
  admin: SupabaseClient,
  flow: ReturnFlow,
  viewerId: string | null,
): Promise<ReturnOutcome> {
  const provider = getPaymentProviderForExistingPayments();
  const target = await findReturnTarget(admin, flow);

  if (!target) {
    paymentLog({ operation: "return", result: "not_found", flow: flow.kind });
    return { kind: "NOT_FOUND", reason: "no se encontró el pago del retorno" };
  }
  const { payment } = target;
  if (viewerId !== null && payment.client_id !== viewerId) {
    paymentLog({
      operation: "return",
      result: "forbidden",
      paymentId: payment.id,
      flow: flow.kind,
    });
    return { kind: "FORBIDDEN", reason: "el pago no pertenece a quien volvió" };
  }

  // Ya resuelto: recargar la página de retorno no vuelve a llamar al banco.
  const settled = alreadySettled(target);
  if (settled) {
    paymentLog({
      operation: "return",
      result: settled.kind === "DOUBLE_CHARGE" ? "already_double_charge" : "already_settled",
      paymentId: payment.id,
      flow: flow.kind,
    });
    return settled;
  }

  // Tres de los cuatro flujos NO confirman. En el flujo con parámetros
  // contradictorios hay un `token_ws` que invitaría a confirmar junto a un
  // `TBK_TOKEN` que dice que algo terminó mal: no se elige por gusto, se
  // consulta el estado, que no depende de lo que traiga la URL.
  if (flow.kind !== "NORMAL") {
    return resolveWithoutCommit(admin, provider, target, flow);
  }
  return commitAndSettle(admin, provider, target, flow.token);
}

/**
 * ¿Hay algo que hacer con este retorno?
 *
 * El intento vigente de un pago ya resuelto, o un intento anterior que ya
 * quedó resuelto con su dinero, no vuelven a llamar al banco. Un intento
 * anterior SIN resolver sí, aunque el pago esté pagado: es exactamente el
 * cobro que antes se perdía.
 */
function alreadySettled({ payment, attempt, current }: ReturnTarget): ReturnOutcome | null {
  if (attempt?.status === "DOUBLE_CHARGE") {
    return { kind: "DOUBLE_CHARGE", payment, reason: "double_charge" };
  }
  if (current && PAYMENT_STATUSES_WITH_MONEY.includes(payment.status)) {
    return { kind: "ALREADY", payment };
  }
  if (!current && attempt && ATTEMPT_STATUSES_WITH_MONEY.includes(attempt.status)) {
    return { kind: "ALREADY", payment };
  }
  return null;
}

/* ---------------------------------------------------------- sin cobro --- */

async function resolveWithoutCommit(
  admin: SupabaseClient,
  provider: PaymentProvider,
  target: ReturnTarget,
  flow: Exclude<ReturnFlow, { kind: "NORMAL" }>,
): Promise<ReturnOutcome> {
  const reason = failureReasonFor(flow) ?? "unknown_return";

  // Con token se puede preguntar. Puede haber una autorización de verdad
  // detrás de un retorno raro, y darla por perdida sería perder dinero.
  if (target.token && isReconcilable(provider)) {
    const snapshot = await provider.inspect(target.token);
    return resolveFromSnapshot(admin, provider.id, target, snapshot, reason, { flow: flow.kind });
  }

  return recordAbandonment(admin, provider.id, target, reason, { flow: flow.kind });
}

/**
 * Lo que diga la consulta de estado de un token, para el retorno y para la
 * conciliación por igual.
 *
 * · Autorizada → se asienta por la misma vía que un `commit`.
 * · Sin resolver en el proveedor → no se toca nada: vuelve a la cola.
 * · Cerrada sin autorizar → se registra el retorno sin cobro con `reason`,
 *   sobre el intento que corresponde.
 */
export async function resolveFromSnapshot(
  admin: SupabaseClient,
  providerId: string,
  target: ReturnTarget,
  snapshot: ProviderSnapshot,
  reason: string,
  details: Record<string, unknown>,
): Promise<ReturnOutcome> {
  // La foto del proveedor va al pago solo si es la de su intento vigente: la
  // de un intento anterior describiría otra transacción.
  if (target.current) await recordSnapshot(admin, target.payment.id, providerId, snapshot);

  if (snapshot.authorized) {
    return settleFromSnapshot(admin, providerId, target, snapshot);
  }

  // El proveedor todavía no ha cerrado la transacción. No se marca nada: el
  // pago se queda en la cola de conciliación, que volverá a preguntar.
  // Declararlo fallido aquí sería decidir por el banco antes que el banco.
  if (snapshot.terminal === false) {
    paymentLog({
      operation: "status",
      result: "still_open",
      paymentId: target.payment.id,
      reason,
    });
    return {
      kind: "PENDING",
      payment: target.payment,
      reason: "el proveedor todavía no ha resuelto la transacción",
    };
  }

  return recordAbandonment(admin, providerId, target, reason, {
    ...details,
    provider_status: snapshot.providerStatus,
    response_code: snapshot.responseCode,
  });
}

/**
 * Retorno sin cobro, sobre el intento que lo trae.
 *
 * La base vuelve a comprobar bajo bloqueo si el intento sigue siendo el
 * vigente: solo entonces el pago pasa a FAILED. Uno anterior cierra solo su
 * fila. Y si no se sabe de qué intento es —una sesión sin orden de compra en
 * un pago con varios intentos—, no se toca nada: el intento en curso puede
 * estar cobrándose en otra pestaña.
 */
async function recordAbandonment(
  admin: SupabaseClient,
  providerId: string,
  target: ReturnTarget,
  reason: string,
  details: Record<string, unknown>,
): Promise<ReturnOutcome> {
  const { payment, attempt, current, token } = target;

  if (!current && !attempt) {
    paymentLog({
      operation: "return",
      result: `${reason}:intento_desconocido`,
      paymentId: payment.id,
    });
    return { kind: "ABANDONED", payment, reason };
  }

  const { data, error } = await admin.rpc("record_payment_abandonment", {
    p_payment_id: payment.id,
    p_provider: providerId,
    p_failure_reason: reason,
    p_details: details,
    p_token: token,
    p_buy_order: attempt?.buy_order ?? (current ? payment.buy_order : null),
  });
  if (error) throw new Error(`No se pudo registrar el retorno: ${error.message}`);

  const scope = (data as { outcome?: string } | null)?.outcome;
  paymentLog({
    operation: "return",
    result: scope === "attempt_only" ? `${reason}:solo_intento` : reason,
    paymentId: payment.id,
  });
  return { kind: "ABANDONED", payment, reason };
}

/* ------------------------------------------------------- flujo normal --- */

async function commitAndSettle(
  admin: SupabaseClient,
  provider: PaymentProvider,
  target: ReturnTarget,
  token: string,
): Promise<ReturnOutcome> {
  const { payment, attempt } = target;

  // Se anota ANTES de llamar. Si el commit se corta en la red después de que
  // Transbank lo procesara, el intento queda marcado: no se abre otro hasta
  // saber en qué terminó, y la conciliación lo vuelve a confirmar.
  if (attempt) {
    await admin
      .from("payment_attempts")
      .update({ commit_requested_at: new Date().toISOString() })
      .eq("id", attempt.id)
      .is("commit_requested_at", null);
  }

  let result: ConfirmPaymentResult;
  try {
    result = await provider.confirmPayment({ token });
  } catch (error) {
    // Confirmar siempre: si el commit falla —ya estaba confirmado, o la red—,
    // se pregunta el estado antes de rendirse. Si tampoco contesta, el error
    // sube y el intento queda en la cola, marcado.
    if (!isReconcilable(provider)) throw error;
    let snapshot: ProviderSnapshot;
    try {
      snapshot = await provider.inspect(token);
    } catch {
      throw error;
    }
    paymentLog({
      operation: "commit",
      result: "commit_failed_status_read",
      paymentId: payment.id,
      errorCategory: errorCategory(error),
    });
    if (snapshot.authorized || snapshot.terminal === false) {
      return resolveFromSnapshot(admin, provider.id, target, snapshot, "rejected_by_issuer", {
        flow: "NORMAL",
      });
    }
    if (target.current) await recordSnapshot(admin, payment.id, provider.id, snapshot);
    return settleResult(admin, provider.id, target, rejectedFromSnapshot(snapshot));
  }

  const committedAt = new Date().toISOString();
  if (attempt) {
    await admin.from("payment_attempts").update({ committed_at: committedAt }).eq("id", attempt.id);
  }
  if (target.current) {
    await admin
      .from("payments")
      .update({ committed_at: committedAt })
      .eq("id", payment.id)
      .eq("provider_token", token);
  }

  // El `commit` contestó algo que no es definitivo (INITIALIZED, sin estado, o
  // uno que no conocemos). NO se asienta.
  //
  // Es la comprobación más importante de todo el retorno. Todo lo que se
  // asienta viaja con `commit:<token>`, y esa clave se registra una sola vez.
  // Asentar aquí un «fallido» provisional gastaría la clave, y cuando el banco
  // autorizara de verdad, la confirmación posterior devolvería `duplicate` sin
  // aplicar nada: cliente cobrado, trabajo sin habilitar y ni un error en
  // ningún sitio.
  if (result.settleable === false) {
    if (result.snapshot && target.current) {
      await recordSnapshot(admin, payment.id, provider.id, result.snapshot);
    }
    paymentLog({
      operation: "commit",
      result: "not_settleable",
      paymentId: payment.id,
      flow: "NORMAL",
      reason: result.snapshot?.providerStatus ?? "sin estado",
    });
    return {
      kind: "PENDING",
      payment,
      reason: "el proveedor todavía no ha resuelto la transacción",
    };
  }

  if (result.snapshot && target.current) {
    await recordSnapshot(admin, payment.id, provider.id, result.snapshot);
  }
  return settleResult(admin, provider.id, target, result);
}

/* ------------------------------------------------------------ asentar --- */

/**
 * Asienta un resultado del proveedor sobre su intento.
 *
 * Autorizado pero inconsistente —otra orden de compra, otra sesión, sin
 * código de autorización— no se da por bueno: el motivo viaja a la base, que
 * deja el pago en revisión SIN pasar por PAID. Antes se asentaba como PAID y
 * después se movía a revisión: en medio, el trabajo quedaba habilitado y al
 * trabajador le llegaba «Ya puedes comenzar».
 */
async function settleResult(
  admin: SupabaseClient,
  providerId: string,
  target: ReturnTarget,
  result: ConfirmPaymentResult,
): Promise<ReturnOutcome> {
  const problems =
    result.status === "PAID" && result.snapshot?.authorized
      ? mismatchesOf(result.snapshot, target)
      : [];
  const reviewReason = problems.length > 0 ? problems.join(",") : null;

  const settlement = await applyProviderResult(admin, target.payment.id, providerId, result, {
    token: target.token,
    reviewReason,
  });

  paymentLog({
    operation: "commit",
    result: settlement.decision ?? settlement.paymentStatus,
    paymentId: target.payment.id,
    duplicate: settlement.outcome === "duplicate",
    reason: reviewReason ?? undefined,
  });

  return outcomeFromSettlement(target.payment, settlement);
}

/**
 * Asienta una autorización descubierta por `status` y no por `commit`.
 *
 * Pasa por la MISMA función de liquidación y con la MISMA clave que el commit
 * del mismo token: no hay una vía «rápida» que salte los invariantes porque el
 * dinero se encontró por otro camino.
 */
function settleFromSnapshot(
  admin: SupabaseClient,
  providerId: string,
  target: ReturnTarget,
  snapshot: ProviderSnapshot,
): Promise<ReturnOutcome> {
  return settleResult(admin, providerId, target, {
    providerTransactionId: snapshot.token,
    providerEventId: `commit:${snapshot.token}`,
    status: "PAID",
    amount: { amount: snapshot.amount ?? target.payment.amount, currency: "CLP" },
    authorizationCode: snapshot.authorizationCode,
    cardLastDigits: snapshot.cardLastDigits,
    paymentTypeCode: snapshot.paymentTypeCode,
    installments: snapshot.installmentsNumber,
    transactionDate: snapshot.transactionDate,
    raw: snapshot.raw,
    snapshot,
  });
}

/** Un rechazo leído con `status`, con la misma clave que tendría su commit. */
function rejectedFromSnapshot(snapshot: ProviderSnapshot): ConfirmPaymentResult {
  return {
    providerTransactionId: snapshot.token,
    providerEventId: `commit:${snapshot.token}`,
    status: "FAILED",
    amount: { amount: snapshot.amount ?? 0, currency: "CLP" },
    authorizationCode: snapshot.authorizationCode,
    cardLastDigits: snapshot.cardLastDigits,
    paymentTypeCode: snapshot.paymentTypeCode,
    installments: snapshot.installmentsNumber,
    transactionDate: snapshot.transactionDate,
    raw: snapshot.raw,
    snapshot,
  };
}

/**
 * Lo que no cuadra entre la transacción y lo que se pidió en ESE intento: su
 * orden de compra y su sesión, no las del intento vigente.
 */
function mismatchesOf(snapshot: ProviderSnapshot, target: ReturnTarget): string[] {
  return findMismatches(
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
      amount: target.payment.amount,
      buyOrder: target.attempt?.buy_order ?? target.payment.buy_order ?? "",
      sessionId: target.attempt?.session_id ?? target.payment.session_id ?? "",
    },
  );
}

/** Lo que decidió la base, traducido a lo que la ruta necesita saber. */
function outcomeFromSettlement(payment: PaymentRow, settlement: SettlementOutcome): ReturnOutcome {
  if (settlement.decision === "DOUBLE_CHARGE" || settlement.attemptStatus === "DOUBLE_CHARGE") {
    return { kind: "DOUBLE_CHARGE", payment, reason: settlement.reviewReason ?? "double_charge" };
  }
  if (settlement.decision !== "ATTEMPT_FAILED" && settlement.paymentStatus === "UNDER_REVIEW") {
    return { kind: "REVIEW", payment, reason: settlement.reviewReason ?? "under_review" };
  }
  return { kind: "SETTLED", payment, settlement };
}
