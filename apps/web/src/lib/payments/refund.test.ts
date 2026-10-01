import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setPaymentProvider } from "./index";
import { MockPaymentProvider } from "./mock-provider";
import {
  PaymentProviderError,
  PaymentProviderNotConfiguredError,
  type PaymentProvider,
  type ProviderRefundResult,
  type RefundPaymentInput,
} from "./provider";
import {
  classifyRefundError,
  classifyRefundResult,
  performRefund,
  refundIdempotencyKey,
} from "./refund";

/**
 * Qué cliente hace cada llamada de una devolución, y qué se registra según lo
 * que conteste el banco.
 *
 * Las pruebas de la base (W08–W16, D01–D51) llaman a las funciones en SQL con
 * la identidad que corresponde. Lo que no pueden ver es el cableado de la
 * aplicación: con qué cliente se llama cada una y qué hace la aplicación con
 * cada forma de respuesta del banco. Estos clientes falsos se comportan como la
 * base real en eso exactamente.
 */

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

interface ServiceOptions {
  /** Lo que contesta `claim_payment_refund`: `false` si otra llamada ya la envió. */
  claimed?: boolean;
  /** La fila de la devolución, para cuando la petición se repite. */
  refundRow?: Record<string, unknown>;
}

function fakeService(calls: Call[], options: ServiceOptions = {}): SupabaseClient {
  const rows: Record<string, Record<string, unknown>> = {
    payment_refunds: options.refundRow ?? { status: "REQUESTED", kind: null, amount: 5000 },
    payments: { provider_token: "tok-prueba", provider_transaction_id: "tok-prueba", status: "PAID" },
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
      // Igual que la base: con la clave de servicio no hay EXECUTE sobre esta.
      if (fn === "request_payment_refund") {
        return { data: null, error: { message: "permission denied for function request_payment_refund" } };
      }
      if (fn === "claim_payment_refund") return { data: options.claimed ?? true, error: null };
      if (fn === "settle_payment_refund") {
        return {
          data: { payment_status: args.p_confirmed ? "PARTIALLY_REFUNDED" : "PAID" },
          error: null,
        };
      }
      if (fn === "mark_payment_refund_unknown") {
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
      if (fn === "request_payment_refund") return { data: "refund-1", error: null };
      // Con la sesión de un usuario, las de la clave de servicio no están concedidas.
      return { data: null, error: { message: `permission denied for function ${fn}` } };
    },
    from: () => {
      throw new Error("la sesión del administrador no debe leer el token del pago");
    },
  } as unknown as SupabaseClient;
}

/** Proveedor que contesta a la devolución lo que la prueba diga. */
function fakeProvider(
  answer: (input: RefundPaymentInput) => Promise<ProviderRefundResult>,
  sent: RefundPaymentInput[] = [],
): PaymentProvider {
  const base = new MockPaymentProvider();
  return Object.assign(base, {
    refundTransaction: async (input: RefundPaymentInput) => {
      sent.push(input);
      return answer(input);
    },
  });
}

function nullified(overrides: Partial<ProviderRefundResult> = {}): ProviderRefundResult {
  return {
    kind: "NULLIFIED",
    confirmed: true,
    refundedAmount: 5000,
    balance: 13000,
    authorizationCode: "123456",
    authorizationDate: "2026-10-01T12:00:00Z",
    responseCode: 0,
    providerEventId: "refund:x",
    raw: {},
    ...overrides,
  };
}

const request = {
  paymentId: "pago-1",
  amount: 5000,
  reason: "Resolución parcial de la disputa",
  idempotencyKey: "refund:prueba",
};

describe("performRefund: cada llamada con su cliente", () => {
  beforeEach(() => setPaymentProvider(new MockPaymentProvider()));
  afterEach(() => setPaymentProvider(null));

  it("pide con la sesión del administrador; reserva y cierra con la clave de servicio", async () => {
    const userCalls: Call[] = [];
    const serviceCalls: Call[] = [];

    const outcome = await performRefund(fakeAdminSession(userCalls), fakeService(serviceCalls), request);

    expect(userCalls.map((c) => c.fn)).toEqual(["request_payment_refund"]);
    expect(serviceCalls.map((c) => c.fn)).toEqual(["claim_payment_refund", "settle_payment_refund"]);
    expect(outcome.state).toBe("CONFIRMED");
    expect(outcome.confirmed).toBe(true);
    expect(outcome.refundId).toBe("refund-1");
  });

  it("con la clave de servicio en las dos posiciones (el cableado anterior) falla siempre", async () => {
    const calls: Call[] = [];
    const service = fakeService(calls);

    await expect(performRefund(service, service, request)).rejects.toThrow(/permission denied/);
    // Y no llegó a reservar, ni a llamar al banco, ni a cerrar nada.
    expect(calls.map((c) => c.fn)).toEqual(["request_payment_refund"]);
  });
});

describe("performRefund: lo que contesta el banco decide cómo se registra", () => {
  afterEach(() => setPaymentProvider(null));

  async function run(answer: () => Promise<ProviderRefundResult>, options: ServiceOptions = {}) {
    const sent: RefundPaymentInput[] = [];
    setPaymentProvider(fakeProvider(answer, sent));
    const serviceCalls: Call[] = [];
    const outcome = await performRefund(
      fakeAdminSession([]),
      fakeService(serviceCalls, options),
      request,
    );
    return { outcome, serviceCalls, sent };
  }

  it("tiempo agotado: queda POR CONFIRMAR, nunca fallida", async () => {
    const { outcome, serviceCalls } = await run(async () => {
      throw new PaymentProviderError("transbank_webpay_plus", "refund: AxiosError: timeout of 600000ms exceeded", {
        requestSent: true,
        httpStatus: null,
      });
    });

    expect(outcome.state).toBe("UNKNOWN");
    expect(outcome.confirmed).toBe(false);
    expect(serviceCalls.map((c) => c.fn)).toEqual(["claim_payment_refund", "mark_payment_refund_unknown"]);
    expect(serviceCalls[1].args.p_reason).toBe("timeout");
  });

  it("un 5xx del banco también queda por confirmar", async () => {
    const { outcome, serviceCalls } = await run(async () => {
      throw new PaymentProviderError("transbank_webpay_plus", "refund: AxiosError: Request failed with status code 502", {
        requestSent: true,
        httpStatus: 502,
      });
    });

    expect(outcome.state).toBe("UNKNOWN");
    expect(serviceCalls[1]).toMatchObject({
      fn: "mark_payment_refund_unknown",
      args: { p_reason: "provider_http_502" },
    });
  });

  it("un 4xx es un rechazo en firme: queda FALLIDA y no se devolvió nada", async () => {
    const { outcome, serviceCalls } = await run(async () => {
      throw new PaymentProviderError("transbank_webpay_plus", "refund: AxiosError: Request failed with status code 422", {
        requestSent: true,
        httpStatus: 422,
      });
    });

    expect(outcome.state).toBe("FAILED");
    expect(outcome.refundedAmount).toBe(0);
    expect(serviceCalls[1]).toMatchObject({
      fn: "settle_payment_refund",
      args: { p_confirmed: false, p_details: { failure_reason: "provider_http_422" } },
    });
  });

  it("una anulación rechazada por código es fallida", async () => {
    const { outcome, serviceCalls } = await run(async () =>
      nullified({ confirmed: false, refundedAmount: 0, responseCode: -1 }),
    );

    expect(outcome.state).toBe("FAILED");
    expect(serviceCalls[1]).toMatchObject({
      fn: "settle_payment_refund",
      args: { p_confirmed: false, p_details: { failure_reason: "provider_rejected" } },
    });
  });

  it("una respuesta que no se entiende queda por confirmar", async () => {
    const { outcome, serviceCalls } = await run(async () =>
      nullified({ kind: "UNKNOWN", confirmed: false, refundedAmount: 0, responseCode: null }),
    );

    expect(outcome.state).toBe("UNKNOWN");
    expect(serviceCalls[1]).toMatchObject({
      fn: "mark_payment_refund_unknown",
      args: { p_reason: "unparsable_response" },
    });
  });

  it("confirmada: se cierra con el importe y el tipo que dijo el banco", async () => {
    const { outcome, serviceCalls } = await run(async () => nullified());

    expect(outcome).toMatchObject({ state: "CONFIRMED", kind: "NULLIFIED", refundedAmount: 5000 });
    expect(serviceCalls[1]).toMatchObject({
      fn: "settle_payment_refund",
      args: { p_confirmed: true, p_kind: "NULLIFIED", p_refunded: 5000 },
    });
  });

  it("la misma petición repetida no vuelve a llamar al banco", async () => {
    const { outcome, serviceCalls, sent } = await run(async () => nullified(), {
      claimed: false,
      refundRow: { status: "REQUESTED", kind: null, amount: 5000 },
    });

    expect(sent).toHaveLength(0);
    expect(serviceCalls.map((c) => c.fn)).toEqual(["claim_payment_refund"]);
    expect(outcome).toMatchObject({ state: "IN_PROGRESS", replayed: true });
  });

  it("repetida sobre una ya por confirmar, contesta eso sin llamar al banco", async () => {
    const { outcome, sent } = await run(async () => nullified(), {
      claimed: false,
      refundRow: { status: "UNKNOWN", kind: null, amount: 5000, unknown_reason: "timeout" },
    });

    expect(sent).toHaveLength(0);
    expect(outcome).toMatchObject({ state: "UNKNOWN", reason: "timeout", replayed: true });
  });

  it("repetida sobre una ya confirmada, devuelve lo que se devolvió", async () => {
    const { outcome, sent } = await run(async () => nullified(), {
      claimed: false,
      refundRow: { status: "CONFIRMED", kind: "NULLIFIED", amount: 5000 },
    });

    expect(sent).toHaveLength(0);
    expect(outcome).toMatchObject({ state: "CONFIRMED", refundedAmount: 5000, replayed: true });
  });
});

describe("refundIdempotencyKey: una clave por petición, no por importe", () => {
  it("la misma petición repetida lleva la misma clave", () => {
    expect(refundIdempotencyKey("pago-1", "peticion-a")).toBe(refundIdempotencyKey("pago-1", "peticion-a"));
  });

  it("dos devoluciones parciales del mismo importe son dos peticiones y dos claves", () => {
    // Antes: (pago, importe, disputa) → la segunda de 5.000 recibía la fila de
    // la primera y «se confirmaba» sin salir dinero.
    expect(refundIdempotencyKey("pago-1", "peticion-a")).not.toBe(
      refundIdempotencyKey("pago-1", "peticion-b"),
    );
  });

  it("reintentar una fallida es otra petición, con otra clave", () => {
    const first = refundIdempotencyKey("pago-1", "peticion-a");
    const retry = refundIdempotencyKey("pago-1", "peticion-c");
    expect(retry).not.toBe(first);
  });

  it("no lleva el identificador del pago a la vista y tiene forma fija", () => {
    const key = refundIdempotencyKey("pago-1", "peticion-a");
    expect(key).toMatch(/^refund:[0-9a-f]{32}$/);
    expect(key).not.toContain("pago-1");
  });
});

describe("classifyRefundError: solo se da por no hecha si consta que no salió o que el banco dijo que no", () => {
  const cases: Array<[string, unknown, "REJECTED" | "UNKNOWN", string]> = [
    [
      "no llegó a salir",
      new PaymentProviderError("p", "refund: sin credenciales", { requestSent: false }),
      "REJECTED",
      "not_sent",
    ],
    ["proveedor sin configurar", new PaymentProviderNotConfiguredError("p"), "REJECTED", "not_sent"],
    [
      "4xx del banco",
      new PaymentProviderError("p", "refund: status code 400", { requestSent: true, httpStatus: 400 }),
      "REJECTED",
      "provider_http_400",
    ],
    [
      "5xx del banco",
      new PaymentProviderError("p", "refund: status code 500", { requestSent: true, httpStatus: 500 }),
      "UNKNOWN",
      "provider_http_500",
    ],
    [
      "tiempo agotado",
      new PaymentProviderError("p", "refund: AxiosError: timeout of 600000ms exceeded", { requestSent: true }),
      "UNKNOWN",
      "timeout",
    ],
    [
      "red caída",
      new PaymentProviderError("p", "refund: AxiosError: getaddrinfo ENOTFOUND webpay3g.transbank.cl", {
        requestSent: true,
      }),
      "UNKNOWN",
      "network",
    ],
    [
      "un error del proveedor sin detalle",
      new PaymentProviderError("p", "refund: algo raro"),
      "UNKNOWN",
      "unknown_error",
    ],
    ["un error cualquiera", new Error("boom"), "UNKNOWN", "unknown_error"],
    ["algo que ni es un error", "texto", "UNKNOWN", "unknown_error"],
  ];

  for (const [label, error, outcome, reason] of cases) {
    it(label, () => {
      expect(classifyRefundError(error)).toEqual({ outcome, reason });
    });
  }
});

describe("classifyRefundResult", () => {
  it("una reversa o una anulación con código 0 es una devolución hecha", () => {
    expect(classifyRefundResult(nullified())).toEqual({ outcome: "CONFIRMED" });
    expect(
      classifyRefundResult(nullified({ kind: "REVERSED", responseCode: null, balance: null })),
    ).toEqual({ outcome: "CONFIRMED" });
  });

  it("una anulación con otro código es un rechazo en firme", () => {
    expect(classifyRefundResult(nullified({ confirmed: false, responseCode: 304 }))).toEqual({
      outcome: "REJECTED",
      reason: "provider_rejected",
    });
  });

  it("sin tipo, o una anulación sin código, no dice nada", () => {
    expect(classifyRefundResult(nullified({ kind: "UNKNOWN", confirmed: false }))).toEqual({
      outcome: "UNKNOWN",
      reason: "unparsable_response",
    });
    expect(classifyRefundResult(nullified({ confirmed: false, responseCode: null }))).toEqual({
      outcome: "UNKNOWN",
      reason: "unparsable_response",
    });
  });
});
