import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setPaymentProvider } from "./index";
import { MockPaymentProvider } from "./mock-provider";
import {
  PaymentProviderError,
  type ConfirmPaymentInput,
  type ConfirmPaymentResult,
  type ProviderSnapshot,
} from "./provider";
import { handleReturn } from "./return-handler";
import { FakeAdmin, type Row } from "./testing/fake-admin";

/**
 * Las decisiones del retorno cuando un pago tiene varios intentos.
 *
 * Lo que decide la BASE —si un cobro es duplicado, si el pago cambia— se prueba
 * en `supabase/tests/13_payment_attempts.sql`. Aquí se prueba lo que decide la
 * aplicación: a qué intento pertenece el retorno, si se llama al banco o no, y
 * con qué identidad se le pasa el resultado a la base.
 */

const PAYMENT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SESSION_ID = "S-0A1B2C3D4E5F4A6B8C7D9E0F1A2B3C4D";
const ORDER_1 = "HTF-0A1B2C3D4E5F-BBBBBBBBB";
const ORDER_2 = "HTF-0A1B2C3D4E5F-CCCCCCCCC";
const AMOUNT = 18000;
const LONG_AGO = new Date(Date.now() - 60 * 60_000).toISOString();

let provider: MockPaymentProvider;

async function createToken(buyOrder: string): Promise<string> {
  const created = await provider.createPayment({
    paymentId: PAYMENT_ID,
    jobId: "trabajo-1",
    reference: "HTF-0001",
    amount: { amount: AMOUNT, currency: "CLP" },
    returnUrl: "http://localhost:3000/pagos/retorno",
    sessionId: SESSION_ID,
    buyOrder,
  });
  return created.token;
}

function paymentRow(overrides: Row = {}): Row {
  return {
    id: PAYMENT_ID,
    job_id: "trabajo-1",
    assignment_id: "asignacion-1",
    client_id: "cliente-1",
    purpose: "JOB",
    amount: AMOUNT,
    currency: "CLP",
    status: "CREATED",
    provider_token: null,
    buy_order: ORDER_2,
    session_id: SESSION_ID,
    environment: "mock",
    attempt: 2,
    created_at: LONG_AGO,
    ...overrides,
  };
}

function attemptRow(attempt: number, overrides: Row = {}): Row {
  return {
    id: `intento-${attempt}`,
    payment_id: PAYMENT_ID,
    attempt,
    status: "CREATED",
    buy_order: attempt === 1 ? ORDER_1 : ORDER_2,
    session_id: SESSION_ID,
    provider_token: null,
    commit_requested_at: null,
    committed_at: null,
    created_at: LONG_AGO,
    token_at: LONG_AGO,
    ...overrides,
  };
}

function snapshotOf(token: string, overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    token,
    maskedToken: null,
    environment: "mock",
    providerStatus: "AUTHORIZED",
    terminal: true,
    responseCode: 0,
    amount: AMOUNT,
    buyOrder: ORDER_1,
    sessionId: SESSION_ID,
    authorizationCode: "1213",
    authorized: true,
    cardLastDigits: "6623",
    paymentTypeCode: "VN",
    installmentsNumber: 0,
    installmentsAmount: null,
    transactionDate: new Date().toISOString(),
    accountingDate: null,
    vci: "TSY",
    balance: null,
    raw: {},
    ...overrides,
  };
}

const settled = (decision: string, paymentStatus: string, extra: Row = {}) => () => ({
  data: {
    outcome: "applied",
    decision,
    payment_status: paymentStatus,
    review_reason: null,
    job_status: null,
    assignment_status: null,
    payout_id: null,
    ...extra,
  },
});

beforeEach(() => {
  provider = new MockPaymentProvider();
  setPaymentProvider(provider);
});
afterEach(() => setPaymentProvider(null));

describe("retorno con el token de un intento anterior", () => {
  it("se busca en el historial y se confirma aunque el pago ya esté pagado", async () => {
    const t1 = await createToken(ORDER_1);
    const t2 = await createToken(ORDER_2);
    const db = new FakeAdmin(
      {
        payments: [paymentRow({ status: "PAID", provider_token: t2 })],
        payment_attempts: [
          attemptRow(1, { provider_token: t1 }),
          attemptRow(2, { provider_token: t2, status: "SETTLED" }),
        ],
      },
      {
        confirm_payment_result: settled("DOUBLE_CHARGE", "PAID", {
          review_reason: "double_charge",
          attempt_status: "DOUBLE_CHARGE",
        }),
      },
    );
    const commit = vi.spyOn(provider, "confirmPayment");

    const outcome = await handleReturn(db.client(), { kind: "NORMAL", token: t1 }, null);

    // Antes: el pago estaba PAID y se respondía «ya resuelto» sin llamar al
    // banco. El segundo cobro no se veía nunca.
    expect(commit).toHaveBeenCalledWith({ token: t1 });
    expect(outcome.kind).toBe("DOUBLE_CHARGE");

    const [call] = db.callsTo("confirm_payment_result");
    expect(call.p_token).toBe(t1);
    expect(call.p_payment_id).toBe(PAYMENT_ID);

    // El commit se anotó en SU intento, antes y después de llamar; el pago no.
    const intento1 = db.tables.payment_attempts[0];
    expect(intento1.commit_requested_at).toBeTruthy();
    expect(intento1.committed_at).toBeTruthy();
    expect(db.updates.filter((u) => u.table === "payments")).toHaveLength(0);
  });

  it("el token vigente de un pago ya pagado no vuelve a llamar al banco", async () => {
    const t2 = await createToken(ORDER_2);
    const db = new FakeAdmin({
      payments: [paymentRow({ status: "PAID", provider_token: t2 })],
      payment_attempts: [attemptRow(2, { provider_token: t2, status: "SETTLED" })],
    });
    const commit = vi.spyOn(provider, "confirmPayment");

    const outcome = await handleReturn(db.client(), { kind: "NORMAL", token: t2 }, null);

    expect(outcome.kind).toBe("ALREADY");
    expect(commit).not.toHaveBeenCalled();
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("un cobro duplicado ya registrado no se vuelve a confirmar al recargar", async () => {
    const t1 = await createToken(ORDER_1);
    const db = new FakeAdmin({
      payments: [paymentRow({ status: "PAID", provider_token: "otro-token" })],
      payment_attempts: [attemptRow(1, { provider_token: t1, status: "DOUBLE_CHARGE" })],
    });
    const commit = vi.spyOn(provider, "confirmPayment");

    const outcome = await handleReturn(db.client(), { kind: "NORMAL", token: t1 }, null);

    expect(outcome.kind).toBe("DOUBLE_CHARGE");
    expect(commit).not.toHaveBeenCalled();
  });

  it("con otra sesión de usuario no toca nada", async () => {
    const t1 = await createToken(ORDER_1);
    const db = new FakeAdmin({
      payments: [paymentRow({ provider_token: "otro-token" })],
      payment_attempts: [attemptRow(1, { provider_token: t1 })],
    });

    const outcome = await handleReturn(db.client(), { kind: "NORMAL", token: t1 }, "otra-persona");

    expect(outcome.kind).toBe("FORBIDDEN");
    expect(db.rpcCalls).toHaveLength(0);
  });
});

describe("retornos sin cobro: solo el intento que los trae", () => {
  it("el abandono de una pestaña anterior se registra con su token, no sobre el vigente", async () => {
    const t1 = await createToken(ORDER_1);
    const t2 = await createToken(ORDER_2);
    const db = new FakeAdmin(
      {
        payments: [paymentRow({ provider_token: t2 })],
        payment_attempts: [
          attemptRow(1, { provider_token: t1 }),
          attemptRow(2, { provider_token: t2 }),
        ],
      },
      {
        record_payment_abandonment: () => ({
          data: { outcome: "attempt_only", payment_status: "CREATED" },
        }),
      },
    );

    const outcome = await handleReturn(
      db.client(),
      { kind: "ABORTED", token: t1, sessionId: SESSION_ID, buyOrder: ORDER_1 },
      null,
    );

    expect(outcome.kind).toBe("ABANDONED");
    const [call] = db.callsTo("record_payment_abandonment");
    expect(call.p_token).toBe(t1);
    expect(call.p_buy_order).toBe(ORDER_1);
    expect(call.p_failure_reason).toBe("aborted_by_user");
    // La foto de otra transacción no se escribe sobre el pago.
    expect(db.callsTo("record_provider_snapshot")).toHaveLength(0);
  });

  it("el abandono del intento vigente sigue cerrando el pago, con su identidad", async () => {
    const t2 = await createToken(ORDER_2);
    const db = new FakeAdmin(
      {
        payments: [paymentRow({ provider_token: t2 })],
        payment_attempts: [attemptRow(2, { provider_token: t2 })],
      },
      {
        record_provider_snapshot: () => ({ data: null }),
        record_payment_abandonment: () => ({ data: { outcome: "applied", payment_status: "FAILED" } }),
      },
    );

    await handleReturn(
      db.client(),
      { kind: "ABORTED", token: t2, sessionId: SESSION_ID, buyOrder: ORDER_2 },
      null,
    );

    const [call] = db.callsTo("record_payment_abandonment");
    expect(call.p_token).toBe(t2);
    expect(call.p_buy_order).toBe(ORDER_2);
    expect(db.callsTo("record_provider_snapshot")).toHaveLength(1);
  });

  it("tiempo agotado con la orden de compra de un intento anterior cierra solo ese", async () => {
    const db = new FakeAdmin(
      {
        payments: [paymentRow({ provider_token: "token-vigente" })],
        payment_attempts: [attemptRow(1), attemptRow(2, { provider_token: "token-vigente" })],
      },
      {
        record_payment_abandonment: () => ({ data: { outcome: "attempt_only" } }),
      },
    );

    await handleReturn(
      db.client(),
      { kind: "TIMEOUT", sessionId: SESSION_ID, buyOrder: ORDER_1 },
      null,
    );

    const [call] = db.callsTo("record_payment_abandonment");
    expect(call.p_buy_order).toBe(ORDER_1);
    expect(call.p_token).toBeNull();
    expect(call.p_failure_reason).toBe("form_timeout");
  });

  it("con solo la sesión y varios intentos no se adivina: el pago no se toca", async () => {
    const db = new FakeAdmin({
      payments: [paymentRow({ provider_token: "token-vigente", attempt: 2 })],
      payment_attempts: [attemptRow(1), attemptRow(2, { provider_token: "token-vigente" })],
    });

    const outcome = await handleReturn(
      db.client(),
      { kind: "TIMEOUT", sessionId: SESSION_ID, buyOrder: null },
      null,
    );

    expect(outcome.kind).toBe("ABANDONED");
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("con solo la sesión y un único intento, es ese", async () => {
    const db = new FakeAdmin(
      {
        payments: [paymentRow({ buy_order: ORDER_1, attempt: 1 })],
        payment_attempts: [attemptRow(1)],
      },
      {
        record_payment_abandonment: () => ({ data: { outcome: "applied", payment_status: "FAILED" } }),
      },
    );

    await handleReturn(db.client(), { kind: "TIMEOUT", sessionId: SESSION_ID, buyOrder: null }, null);

    const [call] = db.callsTo("record_payment_abandonment");
    expect(call.p_buy_order).toBe(ORDER_1);
  });
});

describe("autorizado pero no cuadra", () => {
  it("va a revisión en una sola llamada, con el motivo, sin pasar por PAID", async () => {
    class WrongOrderProvider extends MockPaymentProvider {
      async confirmPayment(input: ConfirmPaymentInput): Promise<ConfirmPaymentResult> {
        const base = await super.confirmPayment(input);
        return {
          ...base,
          providerEventId: `commit:${input.token}`,
          snapshot: snapshotOf(input.token, { buyOrder: "HTF-OTRA-ORDEN" }),
        };
      }
    }
    provider = new WrongOrderProvider();
    setPaymentProvider(provider);
    const t1 = await createToken(ORDER_1);

    const db = new FakeAdmin(
      {
        payments: [paymentRow({ buy_order: ORDER_1, attempt: 1, provider_token: t1 })],
        payment_attempts: [attemptRow(1, { provider_token: t1 })],
      },
      {
        record_provider_snapshot: () => ({ data: null }),
        confirm_payment_result: settled("UNDER_REVIEW", "UNDER_REVIEW", {
          review_reason: "buy_order_mismatch",
        }),
      },
    );

    const outcome = await handleReturn(db.client(), { kind: "NORMAL", token: t1 }, null);

    expect(outcome).toMatchObject({ kind: "REVIEW", reason: "buy_order_mismatch" });
    const calls = db.callsTo("confirm_payment_result");
    expect(calls).toHaveLength(1);
    expect(calls[0].p_result).toBe("PAID");
    expect(calls[0].p_review_reason).toBe("buy_order_mismatch");
    // Lo que antes hacía el retorno después del asiento: mover el pago a mano.
    expect(db.updates.filter((u) => u.table === "payments" && "status" in u.values)).toHaveLength(0);
  });
});

describe("confirmar siempre", () => {
  class CommitFailsProvider extends MockPaymentProvider {
    inspectResult: ProviderSnapshot | Error = new Error("sin red");
    async confirmPayment(): Promise<ConfirmPaymentResult> {
      throw new PaymentProviderError("mock", "commit: socket hang up");
    }
    async inspect(token: string): Promise<ProviderSnapshot> {
      if (this.inspectResult instanceof Error) throw this.inspectResult;
      return { ...this.inspectResult, token };
    }
  }

  it("si el commit falla, se consulta el estado y se asienta con la clave del commit", async () => {
    const flaky = new CommitFailsProvider();
    flaky.inspectResult = snapshotOf("x");
    provider = flaky;
    setPaymentProvider(flaky);

    const db = new FakeAdmin(
      {
        payments: [paymentRow({ buy_order: ORDER_1, attempt: 1, provider_token: "tok-1" })],
        payment_attempts: [attemptRow(1, { provider_token: "tok-1" })],
      },
      {
        record_provider_snapshot: () => ({ data: null }),
        confirm_payment_result: settled("PAID", "PAID"),
      },
    );

    const outcome = await handleReturn(db.client(), { kind: "NORMAL", token: "tok-1" }, null);

    expect(outcome.kind).toBe("SETTLED");
    const [call] = db.callsTo("confirm_payment_result");
    expect(call.p_provider_event_id).toBe("commit:tok-1");
    expect(call.p_token).toBe("tok-1");
    expect(call.p_review_reason).toBeNull();
  });

  it("si el commit falla y el banco sigue sin cerrar la transacción, la marca se retira: se puede reintentar", async () => {
    // Es lo que hace la conciliación con un token que nadie pagó (la pestaña
    // de Webpay se cerró): pasados 15 minutos lo confirma, el commit falla y
    // la consulta contesta INITIALIZED. Si la marca «commit pedido» quedara,
    // `register_payment_attempt` negaría el reintento hasta que el pago
    // saliera de la ventana de conciliación.
    const flaky = new CommitFailsProvider();
    flaky.inspectResult = snapshotOf("x", {
      providerStatus: "INITIALIZED",
      terminal: false,
      authorized: false,
      responseCode: null,
      authorizationCode: null,
    });
    provider = flaky;
    setPaymentProvider(flaky);

    const db = new FakeAdmin(
      {
        payments: [paymentRow({ buy_order: ORDER_1, attempt: 1, provider_token: "tok-1" })],
        payment_attempts: [attemptRow(1, { provider_token: "tok-1" })],
      },
      { record_provider_snapshot: () => ({ data: null }) },
    );

    const outcome = await handleReturn(db.client(), { kind: "NORMAL", token: "tok-1" }, null);

    expect(outcome.kind).toBe("PENDING");
    expect(db.callsTo("confirm_payment_result")).toHaveLength(0);
    expect(db.callsTo("record_payment_abandonment")).toHaveLength(0);
    const intento = db.tables.payment_attempts[0];
    expect(intento.commit_requested_at).toBeNull();
    expect(intento.committed_at).toBeNull();
  });

  it("si no contesta nadie, el error sube y el intento queda marcado como «commit pedido»", async () => {
    const flaky = new CommitFailsProvider();
    provider = flaky;
    setPaymentProvider(flaky);

    const db = new FakeAdmin({
      payments: [paymentRow({ buy_order: ORDER_1, attempt: 1, provider_token: "tok-1" })],
      payment_attempts: [attemptRow(1, { provider_token: "tok-1" })],
    });

    await expect(
      handleReturn(db.client(), { kind: "NORMAL", token: "tok-1" }, null),
    ).rejects.toThrow(/socket hang up/);

    // Es la marca que impide abrir otro intento mientras no se sepa si cobró.
    const intento = db.tables.payment_attempts[0];
    expect(intento.commit_requested_at).toBeTruthy();
    expect(intento.committed_at).toBeNull();
  });
});
