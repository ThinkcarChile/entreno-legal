import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setPaymentProvider } from "./index";
import { MockPaymentProvider } from "./mock-provider";
import { performRefund } from "./refund";

/**
 * Qué cliente hace cada llamada de una devolución.
 *
 * Las pruebas de la base (W08–W16) llaman a `request_payment_refund` en SQL con
 * la identidad del administrador y pasan. Lo que no podían ver es el cableado de
 * la aplicación: el panel la llamaba con la clave de servicio, que no tiene
 * permiso de ejecución sobre esa función, así que toda devolución fallaba con
 * «permission denied». Estos clientes falsos se comportan como la base real en
 * eso exactamente.
 */

interface Call {
  fn: string;
  args: unknown;
}

function fakeService(calls: Call[]): SupabaseClient {
  const rows: Record<string, Record<string, unknown>> = {
    payment_refunds: { status: "REQUESTED", kind: null, amount: 5000 },
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
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      // Igual que la base: con la clave de servicio no hay EXECUTE sobre esta.
      if (fn === "request_payment_refund") {
        return { data: null, error: { message: "permission denied for function request_payment_refund" } };
      }
      if (fn === "settle_payment_refund") {
        return { data: { payment_status: "PARTIALLY_REFUNDED" }, error: null };
      }
      return { data: null, error: { message: `inesperado: ${fn}` } };
    },
    from: (table: string) => builder(table),
  } as unknown as SupabaseClient;
}

function fakeAdminSession(calls: Call[]): SupabaseClient {
  return {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      if (fn === "request_payment_refund") return { data: "refund-1", error: null };
      // Con la sesión de un usuario, settle_payment_refund no está concedida.
      return { data: null, error: { message: `permission denied for function ${fn}` } };
    },
    from: () => {
      throw new Error("la sesión del administrador no debe leer el token del pago");
    },
  } as unknown as SupabaseClient;
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

  it("pide con la sesión del administrador y cierra con la clave de servicio", async () => {
    const userCalls: Call[] = [];
    const serviceCalls: Call[] = [];

    const outcome = await performRefund(fakeAdminSession(userCalls), fakeService(serviceCalls), request);

    expect(userCalls.map((c) => c.fn)).toEqual(["request_payment_refund"]);
    expect(serviceCalls.map((c) => c.fn)).toEqual(["settle_payment_refund"]);
    expect(outcome.confirmed).toBe(true);
    expect(outcome.refundId).toBe("refund-1");
  });

  it("con la clave de servicio en las dos posiciones (el cableado anterior) falla siempre", async () => {
    const calls: Call[] = [];
    const service = fakeService(calls);

    await expect(performRefund(service, service, request)).rejects.toThrow(/permission denied/);
    // Y no llegó a llamar al banco ni a cerrar nada.
    expect(calls.map((c) => c.fn)).toEqual(["request_payment_refund"]);
  });
});
