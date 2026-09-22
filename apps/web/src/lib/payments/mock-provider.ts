import { randomUUID } from "node:crypto";

import { PaymentStatus } from "@/lib/domain/enums";

import { maskToken } from "./transbank/sanitize";

import type {
  ConfirmPaymentInput,
  ConfirmPaymentResult,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  PaymentStatusResult,
  ProviderRefundResult,
  ProviderSnapshot,
  ReconcilableProvider,
  RefundPaymentInput,
  RefundPaymentResult,
} from "./provider";

/**
 * Proveedor simulado para desarrollo y demostraciones.
 *
 * Recorre la misma máquina de estados que un proveedor real para que el resto del
 * sistema (pagos, payouts, disputas) se pueda construir y probar sin credenciales.
 * Nunca debe habilitarse en producción: `getPaymentProvider` lo impide.
 */
export class MockPaymentProvider implements PaymentProvider, ReconcilableProvider {
  readonly id = "mock";
  readonly displayName = "Pago simulado (desarrollo)";
  readonly environment = "mock";

  private readonly store = new Map<
    string,
    { input: CreatePaymentInput; status: PaymentStatus }
  >();

  isConfigured(): boolean {
    return true;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const token = `mock-${randomUUID()}`;
    this.store.set(token, { input, status: PaymentStatus.CREATED });
    const url = new URL(input.returnUrl);
    url.searchParams.set("token_ws", token);
    return {
      providerTransactionId: token,
      redirectUrl: url.toString(),
      token,
      status: PaymentStatus.CREATED,
    };
  }

  async confirmPayment({ token }: ConfirmPaymentInput): Promise<ConfirmPaymentResult> {
    const entry = this.store.get(token);

    // El estado en memoria no sobrevive a un reinicio del servidor de
    // desarrollo. Un token con el formato correcto se acepta igual: quien manda
    // sobre el monto es la fila de `payments`, no este proveedor simulado.
    if (!entry) {
      if (!token.startsWith("mock-")) {
        return {
          providerTransactionId: token,
          providerEventId: `evt-${token}`,
          status: PaymentStatus.FAILED,
          amount: { amount: 0, currency: "CLP" },
          authorizationCode: null,
          cardLastDigits: null,
          paymentTypeCode: null,
          installments: null,
          transactionDate: new Date().toISOString(),
          raw: { mock: true, reason: "token_no_reconocido" },
        };
      }

      return {
        providerTransactionId: token,
        providerEventId: `evt-${token}`,
        status: PaymentStatus.PAID,
        amount: { amount: 0, currency: "CLP" },
        authorizationCode: "MOCK-AUTH",
        cardLastDigits: "4242",
        paymentTypeCode: "VD",
        installments: 0,
        transactionDate: new Date().toISOString(),
        raw: { mock: true, recovered: true },
      };
    }

    entry.status = PaymentStatus.PAID;
    return {
      providerTransactionId: token,
      providerEventId: `evt-${token}`,
      status: PaymentStatus.PAID,
      amount: entry.input.amount,
      authorizationCode: "MOCK-AUTH",
      cardLastDigits: "4242",
      paymentTypeCode: "VD",
      installments: 0,
      transactionDate: new Date().toISOString(),
      raw: { mock: true, paymentId: entry.input.paymentId },
    };
  }

  async getStatus(providerTransactionId: string): Promise<PaymentStatusResult> {
    const entry = this.store.get(providerTransactionId);
    return {
      status: entry?.status ?? PaymentStatus.PENDING,
      raw: { mock: true },
    };
  }

  async refund({ amount }: RefundPaymentInput): Promise<RefundPaymentResult> {
    return { status: PaymentStatus.REFUNDED, refundedAmount: amount, raw: { mock: true } };
  }

  async inspect(token: string): Promise<ProviderSnapshot> {
    const entry = this.store.get(token);
    return mockSnapshot(
      token,
      entry?.input ?? null,
      entry?.status === PaymentStatus.PAID,
      this.environment,
    );
  }

  /**
   * Devolución simulada con la MISMA forma que la real.
   *
   * Por debajo de la mitad del importe se comporta como una anulación parcial
   * y por encima como una reversa, que es la distinción que hace Webpay. No es
   * un detalle decorativo: es lo que permite probar los dos caminos del mapeo
   * sin tocar el ambiente de integración.
   */
  async refundTransaction(input: RefundPaymentInput): Promise<ProviderRefundResult> {
    const entry = this.store.get(input.token);
    const total = entry?.input.amount.amount ?? input.amount.amount;
    const partial = input.amount.amount < total;
    return {
      kind: partial ? "NULLIFIED" : "REVERSED",
      confirmed: true,
      refundedAmount: input.amount.amount,
      balance: partial ? total - input.amount.amount : 0,
      authorizationCode: partial ? "MOCK-NUL" : null,
      authorizationDate: partial ? new Date().toISOString() : null,
      responseCode: partial ? 0 : null,
      providerEventId: `refund:${input.token}:${input.amount.amount}`,
      raw: { mock: true, type: partial ? "NULLIFIED" : "REVERSED" },
    };
  }
}

/**
 * Foto de una transacción simulada.
 *
 * Los proveedores simulados implementan `ReconcilableProvider` igual que el
 * real: así la conciliación, las devoluciones y sus pruebas recorren el mismo
 * código con los tres proveedores, y no hay una rama «solo para Transbank» que
 * nadie ejercite hasta producción.
 */
function mockSnapshot(
  token: string,
  input: CreatePaymentInput | null,
  authorized: boolean,
  environment: string,
): ProviderSnapshot {
  return {
    token,
    maskedToken: maskToken(token),
    environment,
    providerStatus: authorized ? "AUTHORIZED" : "FAILED",
    responseCode: authorized ? 0 : -1,
    amount: input?.amount.amount ?? null,
    buyOrder: input?.buyOrder ?? null,
    sessionId: input?.sessionId ?? null,
    authorizationCode: authorized ? "MOCK-AUTH" : null,
    authorized,
    cardLastDigits: authorized ? "4242" : null,
    paymentTypeCode: authorized ? "VD" : null,
    installmentsNumber: 0,
    installmentsAmount: null,
    transactionDate: new Date().toISOString(),
    accountingDate: null,
    vci: authorized ? "TSY" : "TSN",
    balance: null,
    raw: { mock: true },
  };
}

