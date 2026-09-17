import type { PaymentStatus } from "@/lib/domain/enums";
import type { Money } from "@/lib/utils/money";

/**
 * Contrato de proveedor de pago.
 *
 * Toda la aplicación habla este lenguaje. Transbank, o cualquier otro proveedor,
 * queda detrás de esta interfaz. La UI nunca conoce al proveedor.
 *
 * Nunca se reciben, transmiten ni almacenan datos de tarjeta: el proveedor captura
 * los medios de pago en su propio entorno y aquí solo viajan identificadores.
 */

export interface CreatePaymentInput {
  /** Identificador interno del pago (UUID). Viaja como orden de compra. */
  paymentId: string;
  jobId: string;
  /** Referencia legible del trabajo, para la conciliación. */
  reference: string;
  amount: Money;
  /** URL absoluta a la que el proveedor devuelve al usuario. */
  returnUrl: string;
  /** Identificador de sesión del proveedor, derivado del usuario. Nunca el email. */
  sessionId: string;
}

export interface CreatePaymentResult {
  /** Identificador de la transacción en el proveedor. */
  providerTransactionId: string;
  /** URL a la que se debe redirigir al cliente. */
  redirectUrl: string;
  /** Token que acompaña la redirección, cuando el proveedor lo exige. */
  token: string;
  status: PaymentStatus;
}

export interface ConfirmPaymentInput {
  /** Token devuelto por el proveedor al retornar. */
  token: string;
}

export interface ConfirmPaymentResult {
  providerTransactionId: string;
  status: PaymentStatus;
  amount: Money;
  /** Código de autorización del proveedor, si existe. */
  authorizationCode: string | null;
  /** Últimos dígitos entregados por el proveedor. Nunca el número completo. */
  cardLastDigits: string | null;
  paymentTypeCode: string | null;
  installments: number | null;
  transactionDate: string | null;
  /** Carga útil saneada, para `payment_events`. */
  raw: Record<string, unknown>;
}

export interface RefundPaymentInput {
  providerTransactionId: string;
  token: string;
  amount: Money;
}

export interface RefundPaymentResult {
  status: PaymentStatus;
  refundedAmount: Money;
  raw: Record<string, unknown>;
}

export interface PaymentStatusResult {
  status: PaymentStatus;
  raw: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly id: string;
  readonly displayName: string;
  /** `true` cuando hay credenciales y SDK disponibles. */
  isConfigured(): boolean;

  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  confirmPayment(input: ConfirmPaymentInput): Promise<ConfirmPaymentResult>;
  getStatus(providerTransactionId: string, token: string): Promise<PaymentStatusResult>;
  refund(input: RefundPaymentInput): Promise<RefundPaymentResult>;
}

export class PaymentProviderNotConfiguredError extends Error {
  constructor(providerId: string, detail?: string) {
    super(
      `El proveedor de pago "${providerId}" no está configurado.` +
        (detail ? ` ${detail}` : ""),
    );
    this.name = "PaymentProviderNotConfiguredError";
  }
}

export class PaymentProviderError extends Error {
  constructor(
    providerId: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`[${providerId}] ${message}`);
    this.name = "PaymentProviderError";
  }
}
