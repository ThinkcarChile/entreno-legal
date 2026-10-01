import { describe, expect, it } from "vitest";

import type { PaymentRow } from "./checkout";
import type { ReturnOutcome } from "./return-handler";
import { extensionReturnNotice, returnTargetFor } from "./return-target";
import type { SettlementOutcome } from "./settle";

/**
 * A dónde vuelve el cliente, según el resultado y según QUÉ pagó.
 *
 * El defecto que cierra: un cobro de tiempo adicional rechazado o abandonado
 * volvía a `/pagar/{asignación}`, la pantalla de pago del TRABAJO; como el
 * trabajo ya estaba pagado, esa pantalla redirigía a `?pago=ok` y el cliente
 * leía «Pago confirmado».
 */

function payment(purpose: "JOB" | "EXTENSION", status = "CREATED"): PaymentRow {
  return {
    id: "pago-1",
    job_id: "trabajo-1",
    assignment_id: "asignacion-1",
    client_id: "cliente-1",
    purpose,
    amount: 18000,
    currency: "CLP",
    status,
    provider_token: null,
    buy_order: null,
    session_id: null,
    environment: "mock",
    attempt: 1,
  };
}

function settlement(paymentStatus: string, extra: Partial<SettlementOutcome> = {}): SettlementOutcome {
  return {
    outcome: "applied",
    paymentStatus,
    reviewReason: null,
    jobStatus: null,
    assignmentStatus: null,
    payoutId: null,
    decision: paymentStatus,
    attemptStatus: null,
    ...extra,
  };
}

function outcomesFor(purpose: "JOB" | "EXTENSION"): Record<string, ReturnOutcome> {
  return {
    pagado: { kind: "SETTLED", payment: payment(purpose), settlement: settlement("PAID") },
    rechazado: { kind: "SETTLED", payment: payment(purpose), settlement: settlement("FAILED") },
    revision: { kind: "REVIEW", payment: payment(purpose), reason: "buy_order_mismatch" },
    duplicado: { kind: "DOUBLE_CHARGE", payment: payment(purpose, "PAID"), reason: "double_charge" },
    cancelado: { kind: "ABANDONED", payment: payment(purpose), reason: "aborted_by_user" },
    tiempo: { kind: "ABANDONED", payment: payment(purpose), reason: "form_timeout" },
    conflicto: { kind: "ABANDONED", payment: payment(purpose), reason: "return_conflict" },
    verificando: { kind: "PENDING", payment: payment(purpose), reason: "sin respuesta" },
    yaPagado: { kind: "ALREADY", payment: payment(purpose, "PAID") },
    yaFallido: { kind: "ALREADY", payment: payment(purpose, "FAILED") },
  };
}

describe("returnTargetFor: pago del trabajo", () => {
  const o = outcomesFor("JOB");

  it.each([
    ["pagado", "/mis-trabajos/asignacion-1?pago=ok"],
    ["rechazado", "/pagar/asignacion-1?pago=rechazado"],
    ["revision", "/mis-trabajos/publicados/trabajo-1?pago=revision"],
    ["duplicado", "/mis-trabajos/publicados/trabajo-1?pago=duplicado"],
    ["cancelado", "/pagar/asignacion-1?pago=cancelado"],
    ["tiempo", "/pagar/asignacion-1?pago=tiempo"],
    ["conflicto", "/pagar/asignacion-1?pago=incompleto"],
    ["verificando", "/mis-trabajos/publicados/trabajo-1?pago=verificando"],
    ["yaPagado", "/mis-trabajos/asignacion-1?pago=ok"],
    ["yaFallido", "/pagar/asignacion-1?pago=incompleto"],
  ])("%s → %s", (key, expected) => {
    expect(returnTargetFor(o[key])).toBe(expected);
  });

  it("rechazado con el trabajo ya cancelado: la cancelación quedó completada", () => {
    expect(
      returnTargetFor({
        kind: "SETTLED",
        payment: payment("JOB"),
        settlement: settlement("FAILED", { jobStatus: "CANCELLED" }),
      }),
    ).toBe("/mis-trabajos/publicados/trabajo-1?pago=cancelado");
  });

  it("un pago ya resuelto en revisión no se anuncia como confirmado", () => {
    expect(returnTargetFor({ kind: "ALREADY", payment: payment("JOB", "UNDER_REVIEW") })).toBe(
      "/mis-trabajos/publicados/trabajo-1?pago=revision",
    );
  });
});

describe("returnTargetFor: cobro del tiempo adicional", () => {
  const o = outcomesFor("EXTENSION");

  it.each([
    ["pagado", "extension-ok"],
    ["rechazado", "extension-rechazado"],
    ["revision", "extension-revision"],
    ["duplicado", "extension-duplicado"],
    ["cancelado", "extension-cancelado"],
    ["tiempo", "extension-tiempo"],
    ["conflicto", "extension-incompleto"],
    ["verificando", "extension-verificando"],
    ["yaPagado", "extension-ok"],
    ["yaFallido", "extension-incompleto"],
  ])("%s vuelve a la asignación con ?pago=%s", (key, notice) => {
    expect(returnTargetFor(o[key])).toBe(`/mis-trabajos/asignacion-1?pago=${notice}`);
  });

  it("nunca va a la pantalla de pago del trabajo, y solo el pagado dice «ok»", () => {
    for (const [key, outcome] of Object.entries(o)) {
      const target = returnTargetFor(outcome);
      expect(target, key).not.toContain("/pagar/");
      if (key !== "pagado" && key !== "yaPagado") expect(target, key).not.toContain("ok");
    }
  });

  it("cada aviso que produce existe y dice lo que pasó con ESE cobro", () => {
    for (const [key, outcome] of Object.entries(o)) {
      const pago = new URL(returnTargetFor(outcome), "https://hagotufila.cl").searchParams.get("pago");
      const notice = extensionReturnNotice(pago ?? undefined);
      expect(notice, key).not.toBeNull();
      if (key !== "pagado" && key !== "yaPagado") {
        expect(notice!.title, key).not.toMatch(/confirmado|pagado/i);
        expect(notice!.tone, key).not.toBe("success");
      }
    }
  });

  it("el abandono de una pestaña antigua con el cobro ya pagado por otro intento dice que está pagado", () => {
    expect(
      returnTargetFor({ kind: "ABANDONED", payment: payment("EXTENSION", "PAID"), reason: "aborted_by_user" }),
    ).toBe("/mis-trabajos/asignacion-1?pago=extension-ok");
  });

  it("los avisos del trabajo no se confunden con los del tiempo adicional", () => {
    for (const pago of ["ok", "rechazado", "cancelado", "revision", undefined]) {
      expect(extensionReturnNotice(pago)).toBeNull();
    }
  });
});
