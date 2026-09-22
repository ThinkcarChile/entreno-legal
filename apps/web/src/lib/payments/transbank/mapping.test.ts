import { describe, expect, it } from "vitest";

import { PaymentStatus } from "@/lib/domain/enums";

import {
  extractCardLastDigits,
  findMismatches,
  isAuthorized,
  isSettleable,
  isTerminalStatus,
  isRefundConfirmed,
  refundedAmountOf,
  toPaymentStatus,
  toRefund,
  toTransaction,
} from "./mapping";

/** Respuesta de `commit` con la forma que documenta Transbank. */
const APPROVED = {
  vci: "TSY",
  amount: 44000,
  status: "AUTHORIZED",
  buy_order: "HTF-9F8E7D6C5B4A-K3M9QR",
  session_id: "S-9F8E7D6C5B4A49388271" + "0A1B2C3D4E5F",
  card_detail: { card_number: "6623" },
  accounting_date: "0922",
  transaction_date: "2026-09-22T13:00:00.000Z",
  authorization_code: "123456",
  payment_type_code: "VN",
  response_code: 0,
  installments_amount: 0,
  installments_number: 0,
  balance: 0,
};

const EXPECTED = {
  amount: 44000,
  buyOrder: APPROVED.buy_order,
  sessionId: APPROVED.session_id,
};

describe("criterio de aprobación", () => {
  it("aprueba solo con status AUTHORIZED y response_code 0", () => {
    expect(isAuthorized(toTransaction(APPROVED))).toBe(true);
  });

  it("no aprueba con response_code distinto de 0 aunque diga AUTHORIZED", () => {
    expect(isAuthorized(toTransaction({ ...APPROVED, response_code: -1 }))).toBe(false);
  });

  it("no aprueba con response_code 0 si el estado no es AUTHORIZED", () => {
    expect(isAuthorized(toTransaction({ ...APPROVED, status: "FAILED" }))).toBe(false);
    expect(isAuthorized(toTransaction({ ...APPROVED, status: "INITIALIZED" }))).toBe(false);
  });

  it("NO usa vci como criterio: un vci distinto sigue estando autorizado", () => {
    for (const vci of ["TSY", "TSN", "TO", "ABO", "U3", ""]) {
      expect(isAuthorized(toTransaction({ ...APPROVED, vci }))).toBe(true);
    }
  });

  it("un vci «bueno» no salva una transacción rechazada", () => {
    expect(
      isAuthorized(toTransaction({ ...APPROVED, vci: "TSY", status: "FAILED", response_code: -1 })),
    ).toBe(false);
  });

  it("no aprueba con datos ausentes", () => {
    expect(isAuthorized(toTransaction({}))).toBe(false);
    expect(isAuthorized(toTransaction(null))).toBe(false);
    expect(isAuthorized(toTransaction({ status: "AUTHORIZED" }))).toBe(false);
  });
});

describe("coherencia con lo que se pidió", () => {
  it("una respuesta correcta no tiene descuadres", () => {
    expect(findMismatches(toTransaction(APPROVED), EXPECTED)).toEqual([]);
  });

  it("detecta un importe distinto", () => {
    expect(findMismatches(toTransaction({ ...APPROVED, amount: 1 }), EXPECTED)).toContain(
      "amount_mismatch",
    );
  });

  it("detecta una autorización de otra compra", () => {
    const problems = findMismatches(
      toTransaction({ ...APPROVED, buy_order: "HTF-OTRACOMPRA-XXXXXX" }),
      EXPECTED,
    );
    expect(problems).toContain("buy_order_mismatch");
  });

  it("detecta una sesión distinta", () => {
    expect(
      findMismatches(toTransaction({ ...APPROVED, session_id: "S-OTRA" }), EXPECTED),
    ).toContain("session_id_mismatch");
  });

  it("un AUTHORIZED sin código de autorización es incompleto, no aprobado", () => {
    expect(
      findMismatches(toTransaction({ ...APPROVED, authorization_code: null }), EXPECTED),
    ).toContain("missing_authorization_code");
  });

  it("un importe ausente no se interpreta como cero", () => {
    const problems = findMismatches(toTransaction({ ...APPROVED, amount: null }), EXPECTED);
    expect(problems).toContain("missing_amount");
    expect(problems).not.toContain("amount_mismatch");
  });
});

describe("tarjeta", () => {
  it("se queda con los cuatro últimos dígitos", () => {
    expect(extractCardLastDigits({ card_number: "6623" })).toBe("6623");
  });

  it("recorta aunque llegara algo más largo de lo esperado", () => {
    expect(extractCardLastDigits({ card_number: "4051885600446623" })).toBe("6623");
  });

  it("no inventa dígitos", () => {
    expect(extractCardLastDigits(null)).toBeNull();
    expect(extractCardLastDigits({})).toBeNull();
    expect(extractCardLastDigits({ card_number: "" })).toBeNull();
  });
});

describe("estado interno", () => {
  it("traduce cada estado del proveedor", () => {
    expect(toPaymentStatus(toTransaction(APPROVED))).toBe(PaymentStatus.AUTHORIZED);
    expect(toPaymentStatus(toTransaction({ status: "INITIALIZED" }))).toBe(PaymentStatus.CREATED);
    expect(toPaymentStatus(toTransaction({ status: "FAILED" }))).toBe(PaymentStatus.FAILED);
    expect(toPaymentStatus(toTransaction({ status: "NULLIFIED" }))).toBe(PaymentStatus.REFUNDED);
    expect(toPaymentStatus(toTransaction({ status: "REVERSED" }))).toBe(PaymentStatus.REFUNDED);
    expect(toPaymentStatus(toTransaction({ status: "PARTIALLY_NULLIFIED" }))).toBe(
      PaymentStatus.PARTIALLY_REFUNDED,
    );
  });

  it("un estado desconocido no se convierte en aprobado", () => {
    expect(toPaymentStatus(toTransaction({ status: "ALGO_NUEVO" }))).toBe(PaymentStatus.FAILED);
  });
});

describe("devoluciones", () => {
  it("una reversa se confirma por el tipo: no trae código de respuesta", () => {
    const refund = toRefund({ type: "REVERSED" });
    expect(refund.type).toBe("REVERSED");
    expect(isRefundConfirmed(refund)).toBe(true);
    expect(refundedAmountOf(refund, 44000)).toBe(44000);
  });

  it("una anulación exige response_code 0 y dice cuánto anuló", () => {
    const refund = toRefund({
      type: "NULLIFIED",
      authorization_code: "999888",
      authorization_date: "2026-09-22T13:10:00.000Z",
      nullified_amount: 20000,
      balance: 24000,
      response_code: 0,
    });
    expect(isRefundConfirmed(refund)).toBe(true);
    expect(refundedAmountOf(refund, 20000)).toBe(20000);
    expect(refund.balance).toBe(24000);
  });

  it("una anulación con código distinto de 0 NO devolvió nada", () => {
    const refund = toRefund({ type: "NULLIFIED", nullified_amount: 20000, response_code: -1 });
    expect(isRefundConfirmed(refund)).toBe(false);
    expect(refundedAmountOf(refund, 20000)).toBe(0);
  });

  it("un tipo desconocido no se da por bueno", () => {
    expect(isRefundConfirmed(toRefund({ type: "ALGO" }))).toBe(false);
    expect(isRefundConfirmed(toRefund({}))).toBe(false);
    expect(refundedAmountOf(toRefund({}), 1000)).toBe(0);
  });

  it("la anulación manda su propio importe, no el pedido", () => {
    const refund = toRefund({ type: "NULLIFIED", nullified_amount: 15000, response_code: 0 });
    expect(refundedAmountOf(refund, 20000)).toBe(15000);
  });
});

/**
 * La comprobación que evita el peor fallo de la integración: gastar la clave
 * de idempotencia con un resultado que el banco todavía no ha dado.
 */
describe("qué resultados se pueden asentar", () => {
  it("un estado terminal se asienta", () => {
    for (const status of [
      "AUTHORIZED",
      "FAILED",
      "REVERSED",
      "NULLIFIED",
      "PARTIALLY_NULLIFIED",
      "CAPTURED",
    ]) {
      expect(isTerminalStatus(status)).toBe(true);
      expect(isSettleable(toTransaction({ ...APPROVED, status }))).toBe(true);
    }
  });

  it("INITIALIZED NO se asienta: la transacción sigue viva", () => {
    expect(isTerminalStatus("INITIALIZED")).toBe(false);
    expect(isSettleable(toTransaction({ ...APPROVED, status: "INITIALIZED" }))).toBe(false);
  });

  it("una respuesta sin estado no se asienta", () => {
    expect(isSettleable(toTransaction({}))).toBe(false);
    expect(isSettleable(toTransaction(null))).toBe(false);
    expect(isSettleable(toTransaction({ ...APPROVED, status: null }))).toBe(false);
  });

  it("un estado desconocido no se asienta", () => {
    // Si Transbank añade un estado mañana, lo prudente es no decidir por él.
    expect(isTerminalStatus("ALGO_NUEVO")).toBe(false);
    expect(isSettleable(toTransaction({ ...APPROVED, status: "ALGO_NUEVO" }))).toBe(false);
  });

  it("un INITIALIZED con response_code 0 tampoco se asienta ni se aprueba", () => {
    const tx = toTransaction({ ...APPROVED, status: "INITIALIZED", response_code: 0 });
    expect(isSettleable(tx)).toBe(false);
    expect(isAuthorized(tx)).toBe(false);
  });
});
