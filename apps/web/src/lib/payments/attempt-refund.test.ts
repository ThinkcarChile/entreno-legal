import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";

import { attemptRefundIdempotencyKey, performAttemptRefund } from "./attempt-refund";
import { setPaymentProvider } from "./index";
import { MockPaymentProvider } from "./mock-provider";
import {
  PaymentProviderError,
  type PaymentProvider,
  type ProviderRefundResult,
  type ProviderSnapshot,
  type RefundPaymentInput,
} from "./provider";
import { refundIdempotencyKey } from "./refund";
import { NOT_EXECUTED_AFTER_MINUTES, reconcileAttemptRefunds } from "./refund-reconcile";

/**
 * La devolución de un cobro duplicado: va al token del INTENTO, por el cobro
 * entero que fijó la base, y se registra en `payment_attempt_refunds` con la
 * misma lectura de la respuesta del banco que una devolución de pago.
 *
 * El pago tiene OTRO token —el del intento que pagó el trabajo—. Si algo de
 * esto llegara a usarlo, devolvería el cobro bueno: estas pruebas lo vigilan.
 */

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

const PAYMENT_TOKEN = "tok-del-pago";
const ATTEMPT_TOKEN = "tok-del-intento-duplicado";

interface ServiceOptions {
  claimed?: boolean;
  refundRow?: Record<string, unknown>;
}

function fakeService(calls: Call[], options: ServiceOptions = {}): SupabaseClient {
  const rows: Record<string, Record<string, unknown>> = {
    payment_attempt_refunds: {
      payment_id: "pago-1",
      amount: 21000,
      status: "REQUESTED",
      kind: null,
      failure_reason: null,
      unknown_reason: null,
      ...options.refundRow,
    },
    payment_attempts: { provider_token: ATTEMPT_TOKEN },
    payments: { provider_token: PAYMENT_TOKEN, provider_transaction_id: PAYMENT_TOKEN, status: "PAID" },
  };
  const builder = (table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
    };
    return chain;
  };
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "request_attempt_refund") {
        return { data: null, error: { message: "permission denied for function request_attempt_refund" } };
      }
      if (fn === "claim_attempt_refund") return { data: options.claimed ?? true, error: null };
      if (fn === "settle_attempt_refund") {
        return {
          data: { outcome: "applied", refund_status: args.p_confirmed ? "CONFIRMED" : "FAILED", payment_status: "PAID" },
          error: null,
        };
      }
      if (fn === "mark_attempt_refund_unknown") {
        return { data: { outcome: "applied", refund_status: "UNKNOWN" }, error: null };
      }
      return { data: null, error: { message: `inesperado: ${fn}` } };
    },
    from: (table: string) => builder(table),
  } as unknown as SupabaseClient;
}

function fakeAdminSession(calls: Call[]): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "request_attempt_refund") return { data: "dev-intento-1", error: null };
      return { data: null, error: { message: `permission denied for function ${fn}` } };
    },
    from: () => {
      throw new Error("la sesión del administrador no debe leer el token");
    },
  } as unknown as SupabaseClient;
}

function answering(
  answer: (input: RefundPaymentInput) => Promise<ProviderRefundResult>,
  sent: RefundPaymentInput[],
): PaymentProvider {
  return Object.assign(new MockPaymentProvider(), {
    refundTransaction: async (input: RefundPaymentInput) => {
      sent.push(input);
      return answer(input);
    },
  });
}

const reversed: ProviderRefundResult = {
  kind: "REVERSED",
  confirmed: true,
  refundedAmount: 21000,
  balance: null,
  authorizationCode: null,
  authorizationDate: null,
  responseCode: null,
  providerEventId: "refund:x",
  raw: {},
};

const request = {
  attemptId: "intento-1",
  reason: "Cobro duplicado del intento 1",
  idempotencyKey: "attempt-refund:prueba",
};

afterEach(() => setPaymentProvider(null));

describe("performAttemptRefund", () => {
  async function run(answer: () => Promise<ProviderRefundResult>, options: ServiceOptions = {}) {
    const sent: RefundPaymentInput[] = [];
    setPaymentProvider(answering(answer, sent));
    const userCalls: Call[] = [];
    const serviceCalls: Call[] = [];
    const outcome = await performAttemptRefund(
      fakeAdminSession(userCalls),
      fakeService(serviceCalls, options),
      request,
    );
    return { outcome, userCalls, serviceCalls, sent };
  }

  it("pide con la sesión de administración y devuelve con el token DEL INTENTO, por su cobro entero", async () => {
    const { outcome, userCalls, serviceCalls, sent } = await run(async () => reversed);

    expect(userCalls).toEqual([
      {
        fn: "request_attempt_refund",
        args: {
          p_attempt_id: "intento-1",
          p_reason: "Cobro duplicado del intento 1",
          p_provider_event_id: "attempt-refund:prueba",
        },
      },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].token).toBe(ATTEMPT_TOKEN);
    expect(sent[0].amount).toEqual({ amount: 21000, currency: "CLP" });
    expect(serviceCalls.map((c) => c.fn)).toEqual(["claim_attempt_refund", "settle_attempt_refund"]);
    expect(serviceCalls[1].args).toMatchObject({ p_confirmed: true, p_kind: "REVERSED", p_refunded: 21000 });
    expect(outcome).toMatchObject({ state: "CONFIRMED", refundedAmount: 21000, refundId: "dev-intento-1" });
  });

  it("nunca toca las funciones de devolución del pago", async () => {
    const { serviceCalls } = await run(async () => reversed);

    expect(serviceCalls.map((c) => c.fn).filter((fn) => fn.includes("payment_refund"))).toEqual([]);
  });

  it("tiempo agotado: por confirmar, con la misma lectura que una devolución de pago", async () => {
    const { outcome, serviceCalls } = await run(async () => {
      throw new PaymentProviderError("transbank_webpay_plus", "refund: AxiosError: timeout of 600000ms exceeded", {
        requestSent: true,
        httpStatus: null,
      });
    });

    expect(outcome.state).toBe("UNKNOWN");
    expect(serviceCalls[1]).toMatchObject({ fn: "mark_attempt_refund_unknown", args: { p_reason: "timeout" } });
  });

  it("un 4xx es un rechazo en firme: fallida, se puede volver a pedir", async () => {
    const { outcome, serviceCalls } = await run(async () => {
      throw new PaymentProviderError("transbank_webpay_plus", "refund: Request failed with status code 422", {
        requestSent: true,
        httpStatus: 422,
      });
    });

    expect(outcome.state).toBe("FAILED");
    expect(serviceCalls[1]).toMatchObject({
      fn: "settle_attempt_refund",
      args: { p_confirmed: false, p_details: { failure_reason: "provider_http_422" } },
    });
  });

  it("la misma petición repetida no vuelve a llamar al banco: cuenta lo registrado", async () => {
    const { outcome, sent, serviceCalls } = await run(async () => reversed, {
      claimed: false,
      refundRow: { status: "UNKNOWN", unknown_reason: "network" },
    });

    expect(sent).toHaveLength(0);
    expect(serviceCalls.map((c) => c.fn)).toEqual(["claim_attempt_refund"]);
    expect(outcome).toMatchObject({ state: "UNKNOWN", reason: "network", replayed: true });
  });
});

describe("attemptRefundIdempotencyKey", () => {
  it("una clave por petición, con su propio prefijo y sin el identificador a la vista", () => {
    const key = attemptRefundIdempotencyKey("intento-1", "peticion-a");
    expect(key).toBe(attemptRefundIdempotencyKey("intento-1", "peticion-a"));
    expect(key).not.toBe(attemptRefundIdempotencyKey("intento-1", "peticion-b"));
    expect(key).toMatch(/^attempt-refund:[0-9a-f]{32}$/);
    expect(key).not.toContain("intento-1");
    expect(key.slice("attempt-refund:".length)).not.toBe(
      refundIdempotencyKey("intento-1", "peticion-a").slice("refund:".length),
    );
  });
});

/* ------------------------------------------------- la conciliación */

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const old = NOT_EXECUTED_AFTER_MINUTES + 5;

function pendingAttemptRefund(overrides: Record<string, unknown> = {}) {
  return {
    refund_id: "dev-intento-1",
    attempt_id: "intento-1",
    payment_id: "pago-1",
    status: "UNKNOWN",
    amount: 21000,
    requested_at: minutesAgo(old + 10),
    dispatched_at: minutesAgo(old + 10),
    outcome_unknown_at: minutesAgo(old + 9),
    last_checked_at: null,
    provider: "mock",
    environment: "mock",
    transaction_amount: 21000,
    refunded_amount: 0,
    ...overrides,
  };
}

function fakeQueue(calls: Call[], rows: Record<string, unknown>[]): SupabaseClient {
  const tokens: Record<string, string> = {
    payment_attempts: ATTEMPT_TOKEN,
    payments: PAYMENT_TOKEN,
  };
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "attempt_refunds_pending_reconciliation") return { data: rows, error: null };
      if (fn === "settle_attempt_refund" || fn === "mark_attempt_refund_unknown") {
        return { data: { outcome: "applied" }, error: null };
      }
      if (fn === "claim_attempt_refund") return { data: true, error: null };
      return { data: null, error: { message: `inesperado: ${fn}` } };
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: { provider_token: tokens[table] ?? null }, error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

function statusAnswering(snapshot: Partial<ProviderSnapshot>, inspected: string[]): PaymentProvider {
  return Object.assign(new MockPaymentProvider(), {
    inspect: async (token: string) => {
      inspected.push(token);
      return { token, providerStatus: null, amount: null, balance: null, ...snapshot };
    },
  });
}

describe("reconcileAttemptRefunds", () => {
  it("por confirmar y la transacción del intento reversada por el total: se cierra confirmada", async () => {
    const inspected: string[] = [];
    setPaymentProvider(statusAnswering({ providerStatus: "REVERSED", amount: 21000 }, inspected));
    const calls: Call[] = [];

    const summary = await reconcileAttemptRefunds(fakeQueue(calls, [pendingAttemptRefund()]));

    expect(inspected).toEqual([ATTEMPT_TOKEN]);
    expect(calls[1]).toMatchObject({
      fn: "settle_attempt_refund",
      args: { p_refund_id: "dev-intento-1", p_confirmed: true, p_kind: "REVERSED", p_refunded: 21000 },
    });
    expect(summary).toMatchObject({ examined: 1, resolved: 1 });
    expect(summary.results[0]).toMatchObject({ attemptId: "intento-1", outcome: "confirmed" });
  });

  it("autorizada y sin anular pasado el margen: no se hizo, se cierra como fallida", async () => {
    setPaymentProvider(statusAnswering({ providerStatus: "AUTHORIZED", amount: 21000 }, []));
    const calls: Call[] = [];

    await reconcileAttemptRefunds(fakeQueue(calls, [pendingAttemptRefund()]));

    expect(calls[1]).toMatchObject({
      fn: "settle_attempt_refund",
      args: { p_confirmed: false, p_details: { failure_reason: "not_executed_per_status" } },
    });
  });

  it("lo que no se puede decidir se anota en la devolución del intento y sigue por confirmar", async () => {
    setPaymentProvider(statusAnswering({ providerStatus: "NULLIFIED", amount: 21000, balance: 5000 }, []));
    const calls: Call[] = [];

    const summary = await reconcileAttemptRefunds(fakeQueue(calls, [pendingAttemptRefund()]));

    expect(summary).toMatchObject({ resolved: 0, undecided: 1 });
    expect(calls[1]).toMatchObject({
      fn: "mark_attempt_refund_unknown",
      args: { p_reason: "nullified_with_balance" },
    });
  });
});
