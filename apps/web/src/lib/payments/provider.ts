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
  /** Identificador interno del pago (UUID). */
  paymentId: string;
  jobId: string;
  /** Referencia legible del trabajo, para la conciliación. */
  reference: string;
  amount: Money;
  /** URL absoluta a la que el proveedor devuelve al usuario. */
  returnUrl: string;
  /**
   * Identificador de sesión del proveedor. Nunca el correo, el RUT ni el
   * nombre: es un identificador interno del intento.
   */
  sessionId: string;
  /**
   * Orden de compra. La construye quien crea el pago —no el proveedor— porque
   * tiene que quedar persistida ANTES de salir hacia el proveedor: es lo que
   * permite reencontrar el intento cuando el retorno llega sin token.
   */
  buyOrder?: string;
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
  /**
   * Identifica ESTA confirmación en el proveedor. Una misma confirmación que
   * llega dos veces —el usuario recarga la página de retorno, el proveedor
   * reintenta un webhook— trae el mismo id, y la base la registra una sola
   * vez. Un pago reintentado con otro token es otro evento.
   */
  providerEventId: string;
  status: PaymentStatus;
  amount: Money;
  /** Código de autorización del proveedor, si existe. */
  authorizationCode: string | null;
  /** Últimos dígitos entregados por el proveedor. Nunca el número completo. */
  cardLastDigits: string | null;
  paymentTypeCode: string | null;
  installments: number | null;
  transactionDate: string | null;
  /**
   * `false` cuando el proveedor todavía no ha dicho la última palabra.
   *
   * Un resultado no asentable NO se registra: se deja el pago en la cola de
   * conciliación. Escribirlo gastaría su clave de idempotencia con un
   * resultado provisional, y la autorización posterior se descartaría como
   * duplicada —dinero cobrado y trabajo sin habilitar—.
   *
   * Los proveedores que siempre responden en firme lo dejan en `true`.
   */
  settleable?: boolean;
  /** Carga útil saneada, para `payment_events`. */
  raw: Record<string, unknown>;
  /**
   * Foto completa de la transacción en el proveedor, cuando este la entrega.
   * Es lo que permite comprobar importe, orden de compra y sesión antes de
   * dar por bueno un «autorizado».
   */
  snapshot?: ProviderSnapshot;
}

/**
 * Estado completo de una transacción en el proveedor.
 *
 * Existe porque `PaymentStatusResult` —un estado y un objeto opaco— no da para
 * conciliar: para asentar dinero hay que poder comprobar que la transacción que
 * contestó el banco es la que se pidió. Se documenta aquí y la implementa quien
 * pueda; `ReconcilableProvider` marca a esos.
 */
export interface ProviderSnapshot {
  token: string;
  /** El token enmascarado, que es la única forma en que puede registrarse. */
  maskedToken: string | null;
  environment: string;
  providerStatus: string | null;
  /** ¿El proveedor ya cerró esta transacción? `INITIALIZED` no lo está. */
  terminal?: boolean;
  responseCode: number | null;
  amount: number | null;
  buyOrder: string | null;
  sessionId: string | null;
  authorizationCode: string | null;
  /** El criterio del proveedor, ya aplicado: estado y código, los dos. */
  authorized: boolean;
  cardLastDigits: string | null;
  paymentTypeCode: string | null;
  installmentsNumber: number | null;
  installmentsAmount: number | null;
  transactionDate: string | null;
  accountingDate: string | null;
  /** Resultado de la autenticación 3-D Secure. Informativo, nunca decisorio. */
  vci: string | null;
  balance: number | null;
  raw: Record<string, unknown>;
}

/** Respuesta de una devolución, con la forma que de verdad tiene. */
export interface ProviderRefundResult {
  /** `REVERSED` y `NULLIFIED` traen campos distintos; `UNKNOWN` no se acepta. */
  kind: "REVERSED" | "NULLIFIED" | "UNKNOWN";
  /** `true` solo si el proveedor confirmó la operación, no si se pidió. */
  confirmed: boolean;
  refundedAmount: number;
  balance: number | null;
  authorizationCode: string | null;
  authorizationDate: string | null;
  responseCode: number | null;
  /** Clave de idempotencia de ESTA devolución. */
  providerEventId: string;
  raw: Record<string, unknown>;
}

/**
 * Proveedor que además se puede conciliar y devolver con detalle.
 *
 * Es una interfaz aparte y no más métodos en `PaymentProvider` porque no todos
 * los proveedores tienen por qué ofrecerlo, y porque el contrato básico —crear,
 * confirmar, estado, devolver— sigue siendo el que usa el resto de la
 * aplicación.
 */
export interface ReconcilableProvider {
  readonly id: string;
  readonly environment: string;
  /** Estado completo de la transacción en el proveedor. */
  inspect(token: string): Promise<ProviderSnapshot>;
  refundTransaction(input: RefundPaymentInput): Promise<ProviderRefundResult>;
}

/** ¿Este proveedor sabe conciliar? */
export function isReconcilable(
  provider: PaymentProvider,
): provider is PaymentProvider & ReconcilableProvider {
  return (
    typeof (provider as Partial<ReconcilableProvider>).inspect === "function" &&
    typeof (provider as Partial<ReconcilableProvider>).refundTransaction === "function"
  );
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
  constructor(providerId: string, message: string) {
    super(`[${providerId}] ${message}`);
    this.name = "PaymentProviderError";
  }
}
