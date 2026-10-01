import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";

import { setPaymentProvider } from "./index";
import { MockPaymentProvider } from "./mock-provider";
import type { PaymentProvider, ProviderSnapshot } from "./provider";
import {
  decideUnknownRefund,
  NOT_EXECUTED_AFTER_MINUTES,
  reconcileRefunds,
  STALE_REQUEST_MINUTES,
  type ProviderTransactionView,
  type UnknownRefundFacts,
} from "./refund-reconcile";

/**
 * Conciliación de devoluciones por confirmar.
 *
 * La decisión es pura y se prueba caso por caso: lo único que puede cerrar una
 * devolución sin una persona es una consulta de estado que la explique sin
 * ambigüedad con lo que ya está registrado. La pasada se prueba con clientes
 * falsos que se comportan como la base: qué se lee, qué se cierra y qué se
 * anota para quien la resuelva a mano.
 */

const old = NOT_EXECUTED_AFTER_MINUTES + 5;

function facts(overrides: Partial<UnknownRefundFacts> = {}): UnknownRefundFacts {
  return {
    refundAmount: 5000,
    paymentAmount: 18000,
    confirmedRefunded: 0,
    minutesSinceDispatch: old,
    ...overrides,
  };
}

function tx(overrides: Partial<ProviderTransactionView> = {}): ProviderTransactionView {
  return { status: "AUTHORIZED", amount: 18000, balance: null, ...overrides };
}

describe("decideUnknownRefund", () => {
  it("reversada, y lo pedido era el total sin nada devuelto: se hizo", () => {
    expect(
      decideUnknownRefund(facts({ refundAmount: 18000 }), tx({ status: "REVERSED" })),
    ).toMatchObject({ outcome: "CONFIRMED", kind: "REVERSED", refundedAmount: 18000 });
  });

  it("reversada, pero lo pedido era una parte: no cuadra", () => {
    expect(decideUnknownRefund(facts(), tx({ status: "REVERSED" }))).toMatchObject({
      outcome: "UNDECIDED",
      reason: "reversed_does_not_match",
    });
  });

  it("anulada entera, y lo pedido completa el total: se hizo", () => {
    expect(
      decideUnknownRefund(
        facts({ refundAmount: 13000, confirmedRefunded: 5000 }),
        tx({ status: "NULLIFIED", balance: 0 }),
      ),
    ).toMatchObject({ outcome: "CONFIRMED", kind: "NULLIFIED", refundedAmount: 13000 });
  });

  it("anulada entera sin que lo pedido complete el total: no cuadra", () => {
    expect(decideUnknownRefund(facts(), tx({ status: "NULLIFIED" }))).toMatchObject({
      outcome: "UNDECIDED",
      reason: "nullified_does_not_match",
    });
  });

  it("anulada en parte, con el saldo que deja ESTA devolución: se hizo", () => {
    expect(
      decideUnknownRefund(facts(), tx({ status: "PARTIALLY_NULLIFIED", balance: 13000 })),
    ).toMatchObject({ outcome: "CONFIRMED", kind: "NULLIFIED", refundedAmount: 5000 });
  });

  it("anulada en parte, con el saldo de ANTES de esta devolución: no se hizo", () => {
    expect(
      decideUnknownRefund(
        facts({ confirmedRefunded: 3000 }),
        tx({ status: "PARTIALLY_NULLIFIED", balance: 15000 }),
      ),
    ).toEqual({ outcome: "FAILED", reason: "not_executed_per_status" });
  });

  it("anulada en parte sin saldo informado: no se decide", () => {
    expect(
      decideUnknownRefund(facts(), tx({ status: "PARTIALLY_NULLIFIED", balance: null })),
    ).toMatchObject({ outcome: "UNDECIDED", reason: "partially_nullified_without_balance" });
  });

  it("anulada en parte con un saldo que no explica nada: no se decide", () => {
    expect(
      decideUnknownRefund(facts(), tx({ status: "PARTIALLY_NULLIFIED", balance: 10000 })),
    ).toMatchObject({ outcome: "UNDECIDED", reason: "balance_does_not_match" });
  });

  it("autorizada sin anular y sin devoluciones previas: no se hizo", () => {
    expect(decideUnknownRefund(facts(), tx())).toEqual({
      outcome: "FAILED",
      reason: "not_executed_per_status",
    });
  });

  it("pero no antes del margen: podría seguir en curso del lado del banco", () => {
    expect(
      decideUnknownRefund(facts({ minutesSinceDispatch: NOT_EXECUTED_AFTER_MINUTES - 1 }), tx()),
    ).toMatchObject({ outcome: "UNDECIDED", reason: "too_recent_to_rule_out" });
  });

  it("autorizada con devoluciones confirmadas aquí: no cuadra", () => {
    expect(decideUnknownRefund(facts({ confirmedRefunded: 3000 }), tx())).toMatchObject({
      outcome: "UNDECIDED",
      reason: "authorized_with_confirmed_refunds",
    });
  });

  it("autorizada con un saldo menor que el total: algo se anuló, no cuadra", () => {
    expect(decideUnknownRefund(facts(), tx({ balance: 13000 }))).toMatchObject({
      outcome: "UNDECIDED",
      reason: "authorized_with_balance",
    });
  });

  it("si el importe de la transacción no es el del pago, nada de lo que diga sirve", () => {
    expect(
      decideUnknownRefund(facts(), tx({ status: "PARTIALLY_NULLIFIED", amount: 20000, balance: 15000 })),
    ).toMatchObject({ outcome: "UNDECIDED", reason: "status_amount_mismatch" });
    expect(decideUnknownRefund(facts(), tx({ amount: null }))).toMatchObject({
      outcome: "UNDECIDED",
      reason: "status_without_amount",
    });
  });

  it("un estado que no se espera sobre un pago cobrado: no se decide", () => {
    expect(decideUnknownRefund(facts(), tx({ status: "FAILED" }))).toMatchObject({
      outcome: "UNDECIDED",
      reason: "status_failed",
    });
    expect(decideUnknownRefund(facts(), tx({ status: null }))).toMatchObject({
      outcome: "UNDECIDED",
      reason: "status_missing",
    });
  });
});

/* -------------------------------------------------------------- la pasada */

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    refund_id: "dev-1",
    payment_id: "pago-1",
    status: "UNKNOWN",
    amount: 5000,
    requested_at: minutesAgo(old + 10),
    dispatched_at: minutesAgo(old + 10),
    provider: "mock",
    environment: "mock",
    payment_amount: 18000,
    refunded_amount: 0,
    ...overrides,
  };
}

function fakeService(
  calls: Call[],
  rows: Record<string, unknown>[],
  failOn: { fn: string; refundId: string } | null = null,
): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: { provider_token: "tok-prueba" }, error: null }),
  };
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "refunds_pending_reconciliation") return { data: rows, error: null };
      if (failOn && fn === failOn.fn && args.p_refund_id === failOn.refundId) {
        return { data: null, error: { message: "fallo de la base" } };
      }
      if (fn === "settle_payment_refund" || fn === "mark_payment_refund_unknown") {
        return { data: { outcome: "applied" }, error: null };
      }
      return { data: null, error: { message: `inesperado: ${fn}` } };
    },
    from: () => chain,
  } as unknown as SupabaseClient;
}

/** Proveedor cuya consulta de estado contesta lo que la prueba diga. */
function providerAnswering(
  answer: (token: string) => Promise<Partial<ProviderSnapshot>>,
  inspected: string[] = [],
): PaymentProvider {
  return Object.assign(new MockPaymentProvider(), {
    inspect: async (token: string) => {
      inspected.push(token);
      return { token, providerStatus: null, amount: null, balance: null, ...(await answer(token)) };
    },
  });
}

describe("reconcileRefunds", () => {
  afterEach(() => setPaymentProvider(null));

  it("por confirmar y anulada en parte con el saldo de esta devolución: se cierra confirmada", async () => {
    setPaymentProvider(
      providerAnswering(async () => ({ providerStatus: "PARTIALLY_NULLIFIED", amount: 18000, balance: 13000 })),
    );
    const calls: Call[] = [];

    const summary = await reconcileRefunds(fakeService(calls, [pendingRow()]));

    expect(summary).toMatchObject({ examined: 1, resolved: 1, undecided: 0 });
    expect(calls.map((c) => c.fn)).toEqual(["refunds_pending_reconciliation", "settle_payment_refund"]);
    expect(calls[1].args).toMatchObject({
      p_refund_id: "dev-1",
      p_confirmed: true,
      p_kind: "NULLIFIED",
      p_refunded: 5000,
    });
  });

  it("autorizada sin anular, pasado el margen: se cierra como no hecha", async () => {
    setPaymentProvider(providerAnswering(async () => ({ providerStatus: "AUTHORIZED", amount: 18000 })));
    const calls: Call[] = [];

    await reconcileRefunds(fakeService(calls, [pendingRow()]));

    expect(calls[1]).toMatchObject({
      fn: "settle_payment_refund",
      args: { p_confirmed: false, p_details: { failure_reason: "not_executed_per_status" } },
    });
  });

  it("si no se puede decidir, solo se anota por qué: sigue por confirmar", async () => {
    setPaymentProvider(providerAnswering(async () => ({ providerStatus: "NULLIFIED", amount: 18000 })));
    const calls: Call[] = [];

    const summary = await reconcileRefunds(fakeService(calls, [pendingRow()]));

    expect(summary).toMatchObject({ resolved: 0, undecided: 1 });
    expect(calls[1]).toMatchObject({
      fn: "mark_payment_refund_unknown",
      args: { p_reason: "nullified_does_not_match" },
    });
  });

  it("si Webpay no contesta la consulta, se anota y no se cierra nada", async () => {
    setPaymentProvider(
      providerAnswering(async () => {
        throw new Error("network down");
      }),
    );
    const calls: Call[] = [];

    const summary = await reconcileRefunds(fakeService(calls, [pendingRow()]));

    expect(summary.results[0].outcome).toBe("unreachable");
    expect(calls.map((c) => c.fn)).not.toContain("settle_payment_refund");
    expect(calls[1]).toMatchObject({ fn: "mark_payment_refund_unknown" });
    expect(String(calls[1].args.p_reason)).toMatch(/^status_unavailable:/);
  });

  it("pedida y nunca enviada, pasado el margen: no salió, se cierra como no hecha sin preguntar", async () => {
    const inspected: string[] = [];
    setPaymentProvider(providerAnswering(async () => ({ providerStatus: "AUTHORIZED" }), inspected));
    const calls: Call[] = [];

    await reconcileRefunds(
      fakeService(calls, [
        pendingRow({
          status: "REQUESTED",
          dispatched_at: null,
          requested_at: minutesAgo(STALE_REQUEST_MINUTES + 1),
        }),
      ]),
    );

    expect(inspected).toHaveLength(0);
    expect(calls[1]).toMatchObject({
      fn: "settle_payment_refund",
      args: { p_confirmed: false, p_details: { failure_reason: "not_dispatched" } },
    });
  });

  it("enviada hace poco: sigue en vuelo y no se toca", async () => {
    setPaymentProvider(providerAnswering(async () => ({ providerStatus: "AUTHORIZED" })));
    const calls: Call[] = [];

    const summary = await reconcileRefunds(
      fakeService(calls, [pendingRow({ status: "REQUESTED", dispatched_at: minutesAgo(2), requested_at: minutesAgo(2) })]),
    );

    expect(summary.results[0].outcome).toBe("in_flight");
    expect(calls.map((c) => c.fn)).toEqual(["refunds_pending_reconciliation"]);
  });

  it("enviada y colgada: pasa a por confirmar y se contrasta en la misma pasada", async () => {
    setPaymentProvider(
      providerAnswering(async () => ({ providerStatus: "REVERSED", amount: 18000 })),
    );
    const calls: Call[] = [];

    await reconcileRefunds(
      fakeService(calls, [
        pendingRow({
          status: "REQUESTED",
          amount: 18000,
          dispatched_at: minutesAgo(STALE_REQUEST_MINUTES + 1),
          requested_at: minutesAgo(STALE_REQUEST_MINUTES + 1),
        }),
      ]),
    );

    expect(calls.map((c) => c.fn)).toEqual([
      "refunds_pending_reconciliation",
      "mark_payment_refund_unknown",
      "settle_payment_refund",
    ]);
    expect(calls[1].args.p_reason).toBe("stale_request");
    expect(calls[2].args).toMatchObject({ p_confirmed: true, p_kind: "REVERSED", p_refunded: 18000 });
  });

  it("una devolución de otro ambiente no se pregunta", async () => {
    const inspected: string[] = [];
    setPaymentProvider(providerAnswering(async () => ({ providerStatus: "AUTHORIZED" }), inspected));
    const calls: Call[] = [];

    await reconcileRefunds(fakeService(calls, [pendingRow({ environment: "production" })]));

    expect(inspected).toHaveLength(0);
    expect(calls[1]).toMatchObject({
      fn: "mark_payment_refund_unknown",
      args: { p_reason: "environment_production_vs_mock" },
    });
  });

  it("una fila que falla no detiene la pasada", async () => {
    setPaymentProvider(
      providerAnswering(async () => ({ providerStatus: "PARTIALLY_NULLIFIED", amount: 18000, balance: 13000 })),
    );
    const calls: Call[] = [];

    const summary = await reconcileRefunds(
      fakeService(calls, [pendingRow({ refund_id: "dev-1" }), pendingRow({ refund_id: "dev-2" })], {
        fn: "settle_payment_refund",
        refundId: "dev-1",
      }),
    );

    expect(summary.results.map((r) => r.outcome)).toEqual(["error", "confirmed"]);
  });

  it("sin nada pendiente no pregunta a nadie", async () => {
    const inspected: string[] = [];
    setPaymentProvider(providerAnswering(async () => ({}), inspected));
    const calls: Call[] = [];

    const summary = await reconcileRefunds(fakeService(calls, []), { paymentId: "pago-1", minAgeMinutes: 0 });

    expect(summary.examined).toBe(0);
    expect(inspected).toHaveLength(0);
    expect(calls[0].args).toMatchObject({ p_payment_id: "pago-1", p_min_age_minutes: 0 });
  });
});
