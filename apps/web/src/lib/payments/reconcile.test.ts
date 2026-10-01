import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setPaymentProvider } from "./index";
import { MockPaymentProvider } from "./mock-provider";
import { reconcilePayments } from "./reconcile";
import { FakeAdmin, type Row, type RpcHandler } from "./testing/fake-admin";

/**
 * La conciliación también barre los intentos anteriores de cada pago.
 *
 * Es la otra mitad del historial: un token que ya no es el del pago —una
 * pestaña de Webpay abierta, un `commit` que se cortó antes de que el cliente
 * volviera a pagar— no lo va a traer ningún retorno. Si nadie lo confirma y lo
 * consulta, un cobro real se queda sin dueño.
 */

const PAYMENT_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const ORDER_1 = "HTF-5A6B7C8D9E0F-BBBBBBBBB";
const ORDER_2 = "HTF-5A6B7C8D9E0F-CCCCCCCCC";
const SESSION_ID = "S-5A6B7C8D9E0F4A1B8C2D3E4F5A6B7C8D";
const AMOUNT = 18000;
const LONG_AGO = new Date(Date.now() - 60 * 60_000).toISOString();

let provider: MockPaymentProvider;

async function createToken(buyOrder: string): Promise<string> {
  const created = await provider.createPayment({
    paymentId: PAYMENT_ID,
    jobId: "trabajo-1",
    reference: "HTF-0002",
    amount: { amount: AMOUNT, currency: "CLP" },
    returnUrl: "http://localhost:3000/pagos/retorno",
    sessionId: SESSION_ID,
    buyOrder,
  });
  return created.token;
}

function scenario(attempt1: Row, rpc: Record<string, RpcHandler> = {}) {
  return new FakeAdmin(
    {
      payments: [
        {
          id: PAYMENT_ID,
          job_id: "trabajo-1",
          assignment_id: "asignacion-1",
          client_id: "cliente-1",
          purpose: "JOB",
          amount: AMOUNT,
          currency: "CLP",
          status: "PAID",
          provider_token: "token-que-pago",
          buy_order: ORDER_2,
          session_id: SESSION_ID,
          environment: "mock",
          attempt: 2,
          committed_at: LONG_AGO,
          updated_at: LONG_AGO,
        },
      ],
      payment_attempts: [
        {
          id: "intento-1",
          payment_id: PAYMENT_ID,
          attempt: 1,
          status: "CREATED",
          buy_order: ORDER_1,
          session_id: SESSION_ID,
          provider_token: null,
          commit_requested_at: null,
          committed_at: null,
          created_at: LONG_AGO,
          token_at: LONG_AGO,
          ...attempt1,
        },
      ],
    },
    {
      payments_pending_reconciliation: () => ({ data: [] }),
      payment_attempts_pending_reconciliation: () => ({
        data: [
          {
            attempt_id: "intento-1",
            payment_id: PAYMENT_ID,
            attempt: 1,
            payment_status: "PAID",
            provider: "mock",
            environment: (attempt1.environment as string | undefined) ?? "mock",
            buy_order: ORDER_1,
            created_at: LONG_AGO,
          },
        ],
      }),
      expire_stale_payments: () => ({ data: [] }),
      ...rpc,
    },
  );
}

beforeEach(() => {
  provider = new MockPaymentProvider();
  setPaymentProvider(provider);
});
afterEach(() => setPaymentProvider(null));

describe("reconcilePayments: intentos anteriores", () => {
  it("confirma un intento anterior nunca confirmado y descubre el cobro duplicado", async () => {
    const t1 = await createToken(ORDER_1);
    const db = scenario(
      { provider_token: t1 },
      {
        confirm_payment_result: () => ({
          data: {
            outcome: "applied",
            decision: "DOUBLE_CHARGE",
            payment_status: "PAID",
            review_reason: "double_charge",
            attempt_status: "DOUBLE_CHARGE",
          },
        }),
      },
    );
    const commit = vi.spyOn(provider, "confirmPayment");

    const summary = await reconcilePayments(db.client(), { olderThanMinutes: 5 });

    expect(commit).toHaveBeenCalledWith({ token: t1 });
    expect(db.callsTo("confirm_payment_result")[0].p_token).toBe(t1);
    expect(summary.attemptsExamined).toBe(1);
    expect(summary.doubleCharges).toBe(1);
    expect(summary.results).toEqual([
      expect.objectContaining({
        paymentId: PAYMENT_ID,
        attempt: 1,
        outcome: "double_charge",
        before: "PAID",
        after: "PAID",
      }),
    ]);
  });

  it("un intento reciente no se confirma todavía: solo se consulta, y si no cobró se cierra solo él", async () => {
    const t1 = await createToken(ORDER_1);
    const db = scenario(
      { provider_token: t1, token_at: new Date().toISOString() },
      {
        record_payment_abandonment: () => ({
          data: { outcome: "attempt_only", payment_status: "PAID" },
        }),
      },
    );
    const commit = vi.spyOn(provider, "confirmPayment");

    const summary = await reconcilePayments(db.client(), { olderThanMinutes: 5 });

    expect(commit).not.toHaveBeenCalled();
    const [call] = db.callsTo("record_payment_abandonment");
    expect(call.p_token).toBe(t1);
    expect(call.p_buy_order).toBe(ORDER_1);
    expect(call.p_failure_reason).toBe("reconciled_not_authorized");
    expect(summary.results[0]).toMatchObject({ attempt: 1, outcome: "failed", after: "PAID" });
    expect(summary.changed).toBe(0);
  });

  it("un intento de otro ambiente no se pregunta", async () => {
    const db = scenario({ provider_token: "tok-produccion", environment: "production" });
    const status = vi.spyOn(provider, "inspect");

    const summary = await reconcilePayments(db.client(), { olderThanMinutes: 5 });

    expect(status).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({ attempt: 1, outcome: "skipped" });
  });

  it("si la cola de intentos no se puede leer, la pasada de los pagos sigue", async () => {
    const db = scenario(
      {},
      {
        payment_attempts_pending_reconciliation: () => ({
          error: { message: "relation does not exist" },
        }),
      },
    );

    const summary = await reconcilePayments(db.client(), { olderThanMinutes: 5 });

    expect(summary.attemptsExamined).toBe(0);
    expect(db.callsTo("expire_stale_payments")).toHaveLength(1);
  });
});
