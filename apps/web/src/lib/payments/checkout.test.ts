import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toAppError } from "@/lib/utils/errors";

import { startCheckout, type PaymentRow } from "./checkout";
import { setPaymentProvider } from "./index";
import { MockPaymentProvider } from "./mock-provider";
import { FakeAdmin } from "./testing/fake-admin";

/**
 * La salida hacia Webpay cuando la base se niega a abrir un intento.
 *
 * El tope de intentos seguidos y el «tu pago anterior se está confirmando»
 * viven en `register_payment_attempt` (pruebas C de
 * `supabase/tests/20_payment_lifecycle.sql`). Aquí se prueba lo que hace la
 * aplicación con esa negativa: no llama a Transbank y le muestra a quien paga
 * el mensaje de la base, sin prefijos técnicos.
 */

const PAYMENT: PaymentRow = {
  id: "5f0c2b1e-7a4d-4c3b-9e8f-1a2b3c4d5e6f",
  job_id: "trabajo-1",
  assignment_id: "asignacion-1",
  client_id: "cliente-1",
  purpose: "JOB",
  amount: 21000,
  currency: "CLP",
  status: "CREATED",
  provider_token: null,
  buy_order: null,
  session_id: null,
  environment: "mock",
  attempt: 5,
};

let provider: MockPaymentProvider;

beforeEach(() => {
  provider = new MockPaymentProvider();
  setPaymentProvider(provider);
});
afterEach(() => setPaymentProvider(null));

describe("startCheckout cuando la base no admite otro intento", () => {
  it("el tope de intentos llega tal cual y no se abre ninguna transacción", async () => {
    const message =
      "Hiciste varios intentos de pago en poco tiempo. Espera unos minutos antes de volver a intentarlo";
    const db = new FakeAdmin(
      { payments: [], payment_attempts: [] },
      {
        register_payment_attempt: () => ({
          error: { message, code: "23514" } as { message: string },
        }),
      },
    );
    const create = vi.spyOn(provider, "createPayment");

    const error = await startCheckout(db.client(), PAYMENT, "HTF-0001").catch((e: unknown) => e);

    expect(create).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    // Lo que ve quien paga, por el mismo camino que la acción de servidor.
    expect(toAppError(error, "No pudimos iniciar el pago.").message).toBe(message);
  });

  it("un fallo que no es una regla de la base sigue llevando el contexto", async () => {
    const db = new FakeAdmin(
      { payments: [], payment_attempts: [] },
      {
        register_payment_attempt: () => ({ error: { message: "connection reset by peer" } }),
      },
    );
    const create = vi.spyOn(provider, "createPayment");

    await expect(startCheckout(db.client(), PAYMENT, "HTF-0001")).rejects.toThrow(
      /^No se pudo registrar el intento de pago: connection reset by peer$/,
    );
    expect(create).not.toHaveBeenCalled();
  });
});
