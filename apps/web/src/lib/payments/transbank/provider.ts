import { WebpayPlus, type TransbankTransactionClient } from "./sdk";

import { PaymentStatus } from "@/lib/domain/enums";

import {
  isTrustedRedirect,
  productionBlockers,
  TransbankProductionBlockedError,
  type GuardContext,
  type TransbankSettings,
} from "./config";
import {
  BUY_ORDER_MAX,
  RETURN_URL_MAX,
  SESSION_ID_MAX,
  TOKEN_MAX,
  isValidBuyOrder,
} from "./identifiers";
import {
  isRefundConfirmed,
  refundedAmountOf,
  toPaymentStatus,
  toRefund,
  toTransaction,
  type TransbankRefund,
  type TransbankTransaction,
} from "./mapping";
import { maskToken, sanitizeProviderPayload, scrub } from "./sanitize";

import {
  PaymentProviderError,
  PaymentProviderNotConfiguredError,
  type ConfirmPaymentInput,
  type ConfirmPaymentResult,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type PaymentProvider,
  type PaymentStatusResult,
  type ProviderRefundResult,
  type ProviderSnapshot,
  type RefundPaymentInput,
  type RefundPaymentResult,
  type ReconcilableProvider,
} from "../provider";

/**
 * Webpay Plus, con el SDK oficial `transbank-sdk`.
 *
 * Es la única pieza de la aplicación que conoce Transbank. Nada fuera de aquí
 * importa el SDK: ni una página, ni un componente, ni una acción de servidor,
 * ni un repositorio.
 *
 * Cuatro operaciones y ninguna más, todas del SDK oficial:
 *
 *   create(buyOrder, sessionId, amount, returnUrl)  → token + url
 *   commit(token)                                   → resultado de autorización
 *   status(token)                                   → estado, hasta 7 días
 *   refund(token, amount)                           → reversa o anulación
 *
 * Lo que este objeto NO hace, a propósito: decidir si un pago habilita un
 * trabajo. Eso vive en la base, bajo bloqueos, y llega por
 * `confirm_payment_result`. Aquí solo se traduce lo que contestó el banco.
 */
export class TransbankPaymentProvider implements PaymentProvider, ReconcilableProvider {
  readonly id = "transbank_webpay_plus";
  readonly displayName = "Webpay Plus";

  private transaction: TransbankTransactionClient | null = null;

  // Campos explícitos y no propiedades de parámetro: el verificador corre con
  // el despojado de tipos de Node, que no admite esa sintaxis. Lo que se
  // verifica tiene que poder ejecutarse igual que lo que se despliega.
  private readonly settings: TransbankSettings;
  private readonly guards: GuardContext;

  constructor(settings: TransbankSettings, guards: GuardContext) {
    this.settings = settings;
    this.guards = guards;
  }

  get environment(): "integration" | "production" {
    return this.settings.environment;
  }

  isConfigured(): boolean {
    return Boolean(this.settings.commerceCode && this.settings.apiKey);
  }

  /**
   * Construye la transacción del SDK con el constructor explícito del ambiente.
   *
   * Nunca el constructor por defecto: `new WebpayPlus.Transaction()` sin
   * opciones toma valores implícitos, y un valor implícito en la elección entre
   * integración y producción es una forma de cobrar de verdad sin querer.
   *
   * En producción, antes de construir nada, se comprueban TODAS las guardas. Si
   * alguna falla, no se crea el cliente: no hay manera de que una petición
   * salga hacia el ambiente productivo con la configuración a medias.
   */
  private client(): TransbankTransactionClient {
    if (this.transaction) return this.transaction;

    if (!this.isConfigured()) {
      throw new PaymentProviderNotConfiguredError(
        this.id,
        "Faltan el código de comercio o la llave secreta.",
      );
    }

    if (this.settings.environment === "production") {
      const blockers = productionBlockers(this.guards);
      if (blockers.length > 0) throw new TransbankProductionBlockedError(blockers);
      this.transaction = WebpayPlus.Transaction.buildForProduction(
        this.settings.commerceCode,
        this.settings.apiKey,
      );
      return this.transaction;
    }

    this.transaction = WebpayPlus.Transaction.buildForIntegration(
      this.settings.commerceCode,
      this.settings.apiKey,
    );
    return this.transaction;
  }

  /**
   * Envoltura de toda llamada al SDK.
   *
   * Ninguna excepción del SDK sale de aquí. La razón está en `sanitize.ts`: el
   * `TransbankError` del SDK interpola el error de axios entero, y ese error
   * lleva las cabeceras de la petición —con la llave secreta del comercio—.
   * Lo que sale es un `PaymentProviderError` con un mensaje corto y limpio.
   */
  private async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      // Solo la primera línea: el SDK apila el volcado de axios debajo.
      const firstLine = raw.split("\n")[0]?.slice(0, 300) ?? "error desconocido";
      const safe = scrub(firstLine, [this.settings.apiKey, this.settings.commerceCode]);
      // `cause` se omite deliberadamente: es el objeto que lleva la credencial.
      throw new PaymentProviderError(this.id, `${operation}: ${safe}`);
    }
  }

  /* ----------------------------------------------------------------- crear */

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const { buyOrder, sessionId } = requireIdentifiers(input);

    if (input.amount.currency !== "CLP") {
      throw new PaymentProviderError(this.id, "Webpay Plus solo opera en pesos chilenos.");
    }
    if (!Number.isInteger(input.amount.amount) || input.amount.amount <= 0) {
      throw new PaymentProviderError(this.id, "El importe debe ser un entero positivo en pesos.");
    }
    if (input.returnUrl.length > RETURN_URL_MAX) {
      throw new PaymentProviderError(this.id, "La URL de retorno supera el límite de Webpay.");
    }

    const response = await this.call("create", () =>
      this.client().create(buyOrder, sessionId, input.amount.amount, input.returnUrl),
    );

    const token = String((response as Record<string, unknown>)?.token ?? "");
    const url = String((response as Record<string, unknown>)?.url ?? "");

    if (!token || token.length > TOKEN_MAX) {
      throw new PaymentProviderError(this.id, "Webpay no devolvió un token utilizable.");
    }
    // El destino de la redirección tiene que ser de Transbank y del ambiente
    // que corresponde. Es lo único de esta respuesta que mueve un navegador.
    if (!isTrustedRedirect(url, this.settings.environment)) {
      throw new PaymentProviderError(
        this.id,
        "La URL de redirección no pertenece al dominio esperado de Transbank.",
      );
    }

    return {
      providerTransactionId: token,
      redirectUrl: url,
      token,
      status: PaymentStatus.CREATED,
    };
  }

  /* ------------------------------------------------------------- confirmar */

  async confirmPayment({ token }: ConfirmPaymentInput): Promise<ConfirmPaymentResult> {
    const tx = toTransaction(await this.call("commit", () => this.client().commit(token)));
    return this.toConfirmResult(token, tx);
  }

  /* --------------------------------------------------------------- estado */

  async getStatus(_providerTransactionId: string, token: string): Promise<PaymentStatusResult> {
    void _providerTransactionId;
    const tx = toTransaction(await this.call("status", () => this.client().status(token)));
    return { status: toPaymentStatus(tx), raw: sanitizeProviderPayload(tx) };
  }

  /**
   * Foto completa de la transacción, para conciliar.
   *
   * `getStatus` devuelve un estado; esto devuelve todo lo que hace falta para
   * comprobar que la transacción es la que se esperaba —importe, orden de
   * compra y sesión— antes de asentar nada.
   */
  async inspect(token: string): Promise<ProviderSnapshot> {
    const tx = toTransaction(await this.call("status", () => this.client().status(token)));
    return this.toSnapshot(token, tx);
  }

  /* --------------------------------------------------------------- refund */

  async refund(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const result = await this.refundTransaction(input);
    return {
      status: result.confirmed
        ? result.refundedAmount >= input.amount.amount
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED
        : PaymentStatus.PAID,
      refundedAmount: { amount: result.refundedAmount, currency: "CLP" },
      raw: result.raw,
    };
  }

  /**
   * Devolución con la respuesta completa del proveedor.
   *
   * Nada se marca como devuelto por haber pedido la operación: solo si el
   * proveedor la confirma, y con el importe que él diga que anuló.
   */
  async refundTransaction(input: RefundPaymentInput): Promise<ProviderRefundResult> {
    if (!Number.isInteger(input.amount.amount) || input.amount.amount <= 0) {
      throw new PaymentProviderError(this.id, "El importe a devolver debe ser un entero positivo.");
    }

    const refund: TransbankRefund = toRefund(
      await this.call("refund", () => this.client().refund(input.token, input.amount.amount)),
    );

    return {
      kind: refund.type,
      confirmed: isRefundConfirmed(refund),
      refundedAmount: refundedAmountOf(refund, input.amount.amount),
      balance: refund.balance,
      authorizationCode: refund.authorizationCode,
      authorizationDate: refund.authorizationDate,
      responseCode: refund.responseCode,
      providerEventId: `refund:${input.token}:${input.amount.amount}`,
      raw: sanitizeProviderPayload(refund as unknown),
    };
  }

  /* ------------------------------------------------------------- traducción */

  private toConfirmResult(token: string, tx: TransbankTransaction): ConfirmPaymentResult {
    const authorized = tx.status === "AUTHORIZED" && tx.responseCode === 0;
    return {
      providerTransactionId: token,
      // El evento es la autorización de ESTA transacción. Confirmar dos veces
      // el mismo token es el mismo hecho financiero y se registra una vez.
      providerEventId: `commit:${token}`,
      status: authorized ? PaymentStatus.PAID : PaymentStatus.FAILED,
      amount: { amount: tx.amount ?? 0, currency: "CLP" },
      authorizationCode: tx.authorizationCode,
      cardLastDigits: tx.cardLastDigits,
      paymentTypeCode: tx.paymentTypeCode,
      installments: tx.installmentsNumber,
      transactionDate: tx.transactionDate,
      raw: sanitizeProviderPayload(tx as unknown),
      snapshot: this.toSnapshot(token, tx),
    };
  }

  private toSnapshot(token: string, tx: TransbankTransaction): ProviderSnapshot {
    return {
      token,
      maskedToken: maskToken(token),
      environment: this.settings.environment,
      providerStatus: tx.status,
      responseCode: tx.responseCode,
      amount: tx.amount,
      buyOrder: tx.buyOrder,
      sessionId: tx.sessionId,
      authorizationCode: tx.authorizationCode,
      authorized: tx.status === "AUTHORIZED" && tx.responseCode === 0,
      cardLastDigits: tx.cardLastDigits,
      paymentTypeCode: tx.paymentTypeCode,
      installmentsNumber: tx.installmentsNumber,
      installmentsAmount: tx.installmentsAmount,
      transactionDate: tx.transactionDate,
      accountingDate: tx.accountingDate,
      vci: tx.vci,
      balance: tx.balance,
      raw: sanitizeProviderPayload(tx as unknown),
    };
  }
}

/** Los identificadores los construye quien crea el pago, no el proveedor. */
function requireIdentifiers(input: CreatePaymentInput): {
  buyOrder: string;
  sessionId: string;
} {
  const buyOrder = input.buyOrder ?? "";
  const sessionId = input.sessionId ?? "";

  if (!isValidBuyOrder(buyOrder)) {
    throw new Error(
      `El buy_order no cumple el formato de Webpay (≤ ${BUY_ORDER_MAX}, A-Z 0-9 y guion): ${buyOrder}`,
    );
  }
  if (!sessionId || sessionId.length > SESSION_ID_MAX) {
    throw new Error(`El session_id no cumple el límite de Webpay (≤ ${SESSION_ID_MAX}).`);
  }
  return { buyOrder, sessionId };
}
