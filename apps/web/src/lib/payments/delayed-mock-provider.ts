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

export type DelayedOutcome = "PAID" | "FAILED";

interface Entry {
  input: CreatePaymentInput;
  outcome: DelayedOutcome | null;
  /** Quien esperó a `confirmPayment` antes de que hubiera resultado. */
  waiters: Array<() => void>;
  /** Cuántas veces se pidió confirmar este token. Para las pruebas. */
  confirmations: number;
}

/**
 * Proveedor simulado RETARDADO, para desarrollo y pruebas de concurrencia.
 *
 * El proveedor inmediato (`MockPaymentProvider`) responde PAID en el acto, y
 * eso es exactamente lo que impide reproducir la carrera del dominio: un pago
 * que sigue en vuelo mientras el cliente cancela, una confirmación que llega
 * tarde, la misma confirmación dos veces, dos confirmaciones a la vez.
 *
 * Este proveedor deja el pago creado y NO contesta hasta que alguien decide el
 * resultado con `settle(token, outcome)`. Mientras tanto, cualquier
 * `confirmPayment` se queda esperando en una promesa. Cuando llega el
 * resultado, todos los que esperaban se liberan EN EL MISMO TICK: es una
 * barrera, no un `sleep`. Así dos confirmaciones lanzadas antes de `settle`
 * llegan a la base de datos de forma simultánea y determinista.
 *
 * Nunca en producción: `getPaymentProvider` lo impide igual que al inmediato.
 */
export class DelayedMockPaymentProvider implements PaymentProvider, ReconcilableProvider {
  readonly id = "mock-delayed";
  readonly displayName = "Pago simulado retardado (desarrollo)";
  readonly environment = "mock";

  private readonly store = new Map<string, Entry>();

  isConfigured(): boolean {
    return true;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const token = `mockd-${randomUUID()}`;
    this.store.set(token, { input, outcome: null, waiters: [], confirmations: 0 });
    const url = new URL(input.returnUrl);
    url.searchParams.set("token_ws", token);
    return {
      providerTransactionId: token,
      redirectUrl: url.toString(),
      token,
      status: PaymentStatus.CREATED,
    };
  }

  /**
   * Decide el resultado y libera a todos los que esperaban. Repetir `settle`
   * con el mismo resultado es inocuo; con uno distinto es un error de la
   * prueba, y se dice.
   */
  settle(token: string, outcome: DelayedOutcome): void {
    const entry = this.store.get(token);
    if (!entry) throw new Error(`token desconocido para el proveedor retardado: ${token}`);
    if (entry.outcome && entry.outcome !== outcome) {
      throw new Error(`el token ${token} ya se resolvió como ${entry.outcome}`);
    }
    entry.outcome = outcome;
    const waiters = entry.waiters.splice(0);
    for (const release of waiters) release();
  }

  /** ¿Sigue sin resultado? Para que una prueba compruebe que el pago está en vuelo. */
  isPending(token: string): boolean {
    return this.store.get(token)?.outcome == null;
  }

  confirmationsOf(token: string): number {
    return this.store.get(token)?.confirmations ?? 0;
  }

  async confirmPayment({ token }: ConfirmPaymentInput): Promise<ConfirmPaymentResult> {
    const entry = this.store.get(token);

    // Un token que este proveedor no emitió no se aprueba nunca: a diferencia
    // del proveedor inmediato, aquí no hay «recuperación» tras un reinicio.
    if (!entry) {
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
        raw: { mock: true, delayed: true, reason: "token_no_reconocido" },
      };
    }

    entry.confirmations += 1;

    if (entry.outcome == null) {
      await new Promise<void>((release) => entry.waiters.push(release));
    }

    // Dos confirmaciones del mismo token son EL MISMO evento: mismo id. Es lo
    // que la base usa para registrarlo una sola vez.
    const providerEventId = `evt-${token}`;

    if (entry.outcome === "FAILED") {
      return {
        providerTransactionId: token,
        providerEventId,
        status: PaymentStatus.FAILED,
        amount: entry.input.amount,
        authorizationCode: null,
        cardLastDigits: null,
        paymentTypeCode: null,
        installments: null,
        transactionDate: new Date().toISOString(),
        raw: { mock: true, delayed: true, paymentId: entry.input.paymentId, reason: "rechazado" },
      };
    }

    return {
      providerTransactionId: token,
      providerEventId,
      status: PaymentStatus.PAID,
      amount: entry.input.amount,
      authorizationCode: "MOCKD-AUTH",
      cardLastDigits: "4242",
      paymentTypeCode: "VD",
      installments: 0,
      transactionDate: new Date().toISOString(),
      raw: { mock: true, delayed: true, paymentId: entry.input.paymentId },
    };
  }

  async getStatus(providerTransactionId: string): Promise<PaymentStatusResult> {
    const entry = this.store.get(providerTransactionId);
    const status =
      entry?.outcome === "PAID"
        ? PaymentStatus.PAID
        : entry?.outcome === "FAILED"
          ? PaymentStatus.FAILED
          : PaymentStatus.PENDING;
    return { status, raw: { mock: true, delayed: true } };
  }

  /**
   * Devolución simulada: solo el registro. No hay banco detrás, y el estado
   * contable lo lleva la base (`payments.status = REFUNDED`), no este objeto.
   */
  async refund({ amount }: RefundPaymentInput): Promise<RefundPaymentResult> {
    return { status: PaymentStatus.REFUNDED, refundedAmount: amount, raw: { mock: true, delayed: true } };
  }

  /**
   * Foto de la transacción SIN esperar al resultado.
   *
   * Es a propósito: conciliar un pago que sigue en vuelo tiene que decir «sigue
   * en vuelo», no quedarse colgado hasta que alguien lo resuelva. Es justo el
   * caso que hay que poder probar.
   */
  async inspect(token: string): Promise<ProviderSnapshot> {
    const entry = this.store.get(token);
    const authorized = entry?.outcome === "PAID";
    return {
      token,
      maskedToken: maskToken(token),
      environment: this.environment,
      providerStatus:
        entry == null
          ? "FAILED"
          : entry.outcome == null
            ? "INITIALIZED"
            : authorized
              ? "AUTHORIZED"
              : "FAILED",
      // Un pago todavía en vuelo NO es terminal: es exactamente el caso que
      // este proveedor existe para poder reproducir.
      terminal: entry != null && entry.outcome == null ? false : true,
      responseCode: authorized ? 0 : entry?.outcome === "FAILED" ? -1 : null,
      amount: entry?.input.amount.amount ?? null,
      buyOrder: entry?.input.buyOrder ?? null,
      sessionId: entry?.input.sessionId ?? null,
      authorizationCode: authorized ? "MOCKD-AUTH" : null,
      authorized,
      cardLastDigits: authorized ? "4242" : null,
      paymentTypeCode: authorized ? "VD" : null,
      installmentsNumber: 0,
      installmentsAmount: null,
      transactionDate: new Date().toISOString(),
      accountingDate: null,
      vci: authorized ? "TSY" : null,
      balance: null,
      raw: { mock: true, delayed: true },
    };
  }

  async refundTransaction(input: RefundPaymentInput): Promise<ProviderRefundResult> {
    const entry = this.store.get(input.token);
    const total = entry?.input.amount.amount ?? input.amount.amount;
    const partial = input.amount.amount < total;
    return {
      kind: partial ? "NULLIFIED" : "REVERSED",
      confirmed: true,
      refundedAmount: input.amount.amount,
      balance: partial ? total - input.amount.amount : 0,
      authorizationCode: partial ? "MOCKD-NUL" : null,
      authorizationDate: partial ? new Date().toISOString() : null,
      responseCode: partial ? 0 : null,
      providerEventId: `refund:${input.token}:${input.amount.amount}`,
      raw: { mock: true, delayed: true, type: partial ? "NULLIFIED" : "REVERSED" },
    };
  }
}
