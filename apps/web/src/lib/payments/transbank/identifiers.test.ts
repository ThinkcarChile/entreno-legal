import { describe, expect, it } from "vitest";

import {
  BUY_ORDER_MAX,
  SESSION_ID_MAX,
  buildBuyOrder,
  buildSessionId,
  isValidBuyOrder,
  paymentFingerprintOf,
  paymentIdFromSessionId,
} from "./identifiers";

const PAYMENT = "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f";

describe("buy_order", () => {
  it("cabe en el límite de Webpay y usa solo caracteres permitidos", () => {
    for (let i = 0; i < 200; i += 1) {
      const order = buildBuyOrder(PAYMENT);
      // 26 exactos: el máximo que admite Webpay, aprovechado entero.
      expect(order.length).toBe(BUY_ORDER_MAX);
      expect(order).toMatch(/^[A-Z0-9-]+$/);
      expect(isValidBuyOrder(order)).toBe(true);
    }
  });

  it("no lleva acentos ni datos personales", () => {
    const order = buildBuyOrder(PAYMENT);
    expect(order.normalize("NFD")).toBe(order);
    expect(order).not.toMatch(/[áéíóúñÁÉÍÓÚÑ@]/);
  });

  it("es trazable hasta el pago que lo originó", () => {
    const order = buildBuyOrder(PAYMENT);
    expect(paymentFingerprintOf(order)).toBe("9F8E7D6C5B4A");
  });

  it("no se repite al reintentar", () => {
    // 20.000 órdenes del MISMO pago. Con un sufijo de seis caracteres esto
    // fallaba: el verificador encontró una colisión en 10.000 a la primera.
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(buildBuyOrder(PAYMENT));
    expect(seen.size).toBe(20_000);
  });

  it("no depende del reloj: dos en el mismo instante difieren", () => {
    const a = buildBuyOrder(PAYMENT);
    const b = buildBuyOrder(PAYMENT);
    expect(a).not.toBe(b);
  });

  it("rechaza un identificador de pago que no es un UUID", () => {
    expect(() => buildBuyOrder("no-es-uuid")).toThrow();
  });

  it("no reconoce como propia una orden ajena", () => {
    expect(paymentFingerprintOf("ORDEN-DE-OTRO-COMERCIO")).toBeNull();
    expect(paymentFingerprintOf("HTF-ZZZZZZZZZZZZ-ABCDEF")).toBeNull();
  });

  it("rechaza formatos inválidos", () => {
    expect(isValidBuyOrder("")).toBe(false);
    expect(isValidBuyOrder("orden en minúsculas")).toBe(false);
    expect(isValidBuyOrder("A".repeat(27))).toBe(false);
    expect(isValidBuyOrder("HTF_123")).toBe(false);
  });
});

describe("session_id", () => {
  it("cabe en el límite y no lleva datos personales", () => {
    const id = buildSessionId(PAYMENT);
    expect(id.length).toBeLessThanOrEqual(SESSION_ID_MAX);
    expect(id).not.toContain("@");
    expect(id).toMatch(/^S-[0-9A-F]{32}$/);
  });

  it("permite volver del retorno al intento interno", () => {
    expect(paymentIdFromSessionId(buildSessionId(PAYMENT))).toBe(PAYMENT);
  });

  it("no acepta una sesión que no es nuestra", () => {
    expect(paymentIdFromSessionId("sesion-de-otro")).toBeNull();
    expect(paymentIdFromSessionId("")).toBeNull();
  });
});
