import { randomUUID } from "node:crypto";

import { PaymentStatus } from "@/lib/domain/enums";

import type {
  ConfirmPaymentInput,
  ConfirmPaymentResult,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  PaymentStatusResult,
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
export class MockPaymentProvider implements PaymentProvider {
  readonly id = "mock";
  readonly displayName = "Pago simulado (desarrollo)";

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
    if (!entry) {
      return {
        providerTransactionId: token,
        status: PaymentStatus.FAILED,
        amount: { amount: 0, currency: "CLP" },
        authorizationCode: null,
        cardLastDigits: null,
        paymentTypeCode: null,
        installments: null,
        transactionDate: new Date().toISOString(),
        raw: { mock: true, reason: "token_desconocido" },
      };
    }

    entry.status = PaymentStatus.PAID;
    return {
      providerTransactionId: token,
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
}
