import { PaymentStatus } from "@/lib/domain/enums";

/**
 * Traducción entre lo que contesta Webpay Plus y lo que entiende el dominio.
 *
 * Sin red y sin SDK: son funciones puras sobre objetos sueltos, para que se
 * puedan probar con las respuestas reales guardadas de integración.
 *
 * Los nombres de campo salen de la documentación oficial de Webpay Plus, no de
 * la memoria: la respuesta de `commit` y de `status` trae `vci`, `amount`,
 * `status`, `buy_order`, `session_id`, `card_detail`, `accounting_date`,
 * `transaction_date`, `authorization_code`, `payment_type_code`,
 * `response_code`, `installments_amount`, `installments_number` y `balance`.
 */

/** Estados que devuelve Webpay en el campo `status`. */
export const TRANSBANK_STATUS = {
  INITIALIZED: "INITIALIZED",
  AUTHORIZED: "AUTHORIZED",
  REVERSED: "REVERSED",
  FAILED: "FAILED",
  NULLIFIED: "NULLIFIED",
  PARTIALLY_NULLIFIED: "PARTIALLY_NULLIFIED",
  CAPTURED: "CAPTURED",
} as const;

export interface TransbankTransaction {
  vci: string | null;
  amount: number | null;
  status: string | null;
  buyOrder: string | null;
  sessionId: string | null;
  cardLastDigits: string | null;
  accountingDate: string | null;
  transactionDate: string | null;
  authorizationCode: string | null;
  paymentTypeCode: string | null;
  responseCode: number | null;
  installmentsAmount: number | null;
  installmentsNumber: number | null;
  balance: number | null;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function int(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return null;
}

/**
 * Los últimos cuatro dígitos vienen dentro de `card_detail.card_number`.
 *
 * Transbank entrega ahí SOLO los cuatro últimos, pero esta función recorta de
 * todas formas: si algún día llegara algo más largo, no se persiste un número
 * de tarjeta por descuido. Es una red, no una suposición.
 */
export function extractCardLastDigits(cardDetail: unknown): string | null {
  if (cardDetail === null || typeof cardDetail !== "object") return null;
  const raw = (cardDetail as Record<string, unknown>).card_number;
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 0) return null;
  return digits.slice(-4);
}

/** Normaliza la respuesta de `commit` o de `status` a una forma estable. */
export function toTransaction(response: unknown): TransbankTransaction {
  const r = (response ?? {}) as Record<string, unknown>;
  return {
    vci: str(r.vci),
    amount: int(r.amount),
    status: str(r.status),
    buyOrder: str(r.buy_order),
    sessionId: str(r.session_id),
    cardLastDigits: extractCardLastDigits(r.card_detail),
    accountingDate: str(r.accounting_date),
    transactionDate: str(r.transaction_date),
    authorizationCode: str(r.authorization_code),
    paymentTypeCode: str(r.payment_type_code),
    responseCode: int(r.response_code),
    installmentsAmount: int(r.installments_amount),
    installmentsNumber: int(r.installments_number),
    balance: int(r.balance),
  };
}

/**
 * ¿La transacción está autorizada?
 *
 * La regla es de la documentación, literal: «debes confirmar que el código de
 * respuesta `response_code` sea exactamente 0 y que el estado `status` sea
 * exactamente AUTHORIZED». Las dos cosas, no una.
 *
 * `vci` NO entra en la decisión. Indica el resultado de la autenticación 3-D
 * Secure, que es información útil para el riesgo pero no es la autorización
 * financiera: hay `vci` de valores distintos sobre transacciones igualmente
 * autorizadas, y hay `TSY` sobre transacciones que luego se rechazan.
 */
export function isAuthorized(tx: TransbankTransaction): boolean {
  return tx.status === TRANSBANK_STATUS.AUTHORIZED && tx.responseCode === 0;
}

/** Motivos por los que una respuesta aprobada no se puede dar por buena. */
export type MismatchReason =
  | "amount_mismatch"
  | "buy_order_mismatch"
  | "session_id_mismatch"
  | "missing_authorization_code"
  | "missing_amount";

export interface ExpectedTransaction {
  amount: number;
  buyOrder: string;
  sessionId: string;
}

/**
 * Comprueba que lo que contestó el proveedor es lo que se pidió.
 *
 * Una autorización correcta sobre OTRA compra sigue siendo dinero que no
 * corresponde a este trabajo. Se comparan importe, orden de compra y sesión, y
 * se exige que haya código de autorización: un `AUTHORIZED` sin él es una
 * respuesta incompleta, no una aprobación.
 */
export function findMismatches(
  tx: TransbankTransaction,
  expected: ExpectedTransaction,
): MismatchReason[] {
  const problems: MismatchReason[] = [];
  if (tx.amount === null) problems.push("missing_amount");
  else if (tx.amount !== expected.amount) problems.push("amount_mismatch");
  if (tx.buyOrder !== expected.buyOrder) problems.push("buy_order_mismatch");
  if (tx.sessionId !== expected.sessionId) problems.push("session_id_mismatch");
  if (!tx.authorizationCode) problems.push("missing_authorization_code");
  return problems;
}

/**
 * Estado interno que corresponde a una transacción del proveedor.
 *
 * `UNDER_REVIEW` no se decide aquí: lo decide quien compara con lo esperado.
 * Esto solo traduce el estado del proveedor.
 */
export function toPaymentStatus(tx: TransbankTransaction): PaymentStatus {
  if (isAuthorized(tx)) return PaymentStatus.AUTHORIZED;
  switch (tx.status) {
    case TRANSBANK_STATUS.INITIALIZED:
      return PaymentStatus.CREATED;
    case TRANSBANK_STATUS.REVERSED:
      return PaymentStatus.REFUNDED;
    case TRANSBANK_STATUS.NULLIFIED:
      return PaymentStatus.REFUNDED;
    case TRANSBANK_STATUS.PARTIALLY_NULLIFIED:
      return PaymentStatus.PARTIALLY_REFUNDED;
    default:
      return PaymentStatus.FAILED;
  }
}

/* ------------------------------------------------------------------ refunds */

/**
 * Respuesta de `refund`, que tiene DOS formas según lo que haya hecho el
 * banco:
 *
 * · **REVERSED** — reversa. Ocurre cuando se pide el total dentro de la
 *   ventana del mismo día, antes de la captura. La respuesta trae poco más que
 *   el tipo: no hay código ni fecha de autorización de la anulación, porque no
 *   hubo una operación nueva; se deshizo la original.
 * · **NULLIFIED** — anulación. Ocurre fuera de esa ventana o por un importe
 *   menor. Es una operación propia, y por eso sí trae `authorization_code`,
 *   `authorization_date`, `nullified_amount`, `balance` y `response_code`.
 *
 * Tratar las dos como si trajeran los mismos campos es lo que produce un
 * «devuelto» registrado con importe nulo.
 */
export type RefundKind = "REVERSED" | "NULLIFIED" | "UNKNOWN";

export interface TransbankRefund {
  type: RefundKind;
  authorizationCode: string | null;
  authorizationDate: string | null;
  nullifiedAmount: number | null;
  balance: number | null;
  responseCode: number | null;
}

export function toRefund(response: unknown): TransbankRefund {
  const r = (response ?? {}) as Record<string, unknown>;
  const rawType = str(r.type)?.toUpperCase();
  const type: RefundKind =
    rawType === "REVERSED" || rawType === "NULLIFIED" ? rawType : "UNKNOWN";
  return {
    type,
    authorizationCode: str(r.authorization_code),
    authorizationDate: str(r.authorization_date),
    nullifiedAmount: int(r.nullified_amount),
    balance: int(r.balance),
    responseCode: int(r.response_code),
  };
}

/**
 * ¿La devolución se hizo de verdad?
 *
 * Una reversa se da por buena por el tipo: no hay código de respuesta que
 * mirar. Una anulación exige `response_code = 0`, como cualquier otra
 * operación financiera de Webpay. Todo lo demás es que no ocurrió, y no se
 * marca nada como devuelto.
 */
export function isRefundConfirmed(refund: TransbankRefund): boolean {
  if (refund.type === "REVERSED") return true;
  if (refund.type === "NULLIFIED") return refund.responseCode === 0;
  return false;
}

/** Cuánto se devolvió de verdad, según la forma de la respuesta. */
export function refundedAmountOf(refund: TransbankRefund, requested: number): number {
  if (!isRefundConfirmed(refund)) return 0;
  // La reversa siempre es por el total pedido; la anulación dice cuánto anuló.
  if (refund.type === "REVERSED") return requested;
  return refund.nullifiedAmount ?? requested;
}
