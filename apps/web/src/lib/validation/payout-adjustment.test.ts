import { describe, expect, it } from "vitest";

import { formatMoney } from "@/lib/utils/money";

import { adjustmentSummary, checkPayoutAdjustment } from "./payout-adjustment";

const clp = (amount: number) => formatMoney({ amount, currency: "CLP" });
const MOTIVO = "Se le devolvieron $5.000 al cliente por una parte no hecha.";

/**
 * La misma regla que `public.adjust_payout` en la base. Los casos son los de
 * `supabase/tests/19_payout_decisions.sql` (B29–B38), para que las dos copias
 * no se separen en silencio.
 */
describe("checkPayoutAdjustment", () => {
  it("baja el neto, con motivo", () => {
    expect(checkPayoutAdjustment(18480, 16000, MOTIVO)).toEqual({
      ok: true,
      netAmount: 16000,
      cancels: false,
    });
  });

  it("con $0 cancela el pago", () => {
    expect(checkPayoutAdjustment(18480, 0, MOTIVO)).toEqual({ ok: true, netAmount: 0, cancels: true });
  });

  it("nunca lo sube", () => {
    const result = checkPayoutAdjustment(18480, 19000, MOTIVO);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.field).toBe("netAmount");
    expect(result.ok ? "" : result.error).toContain(clp(18480));
  });

  it("el mismo neto no es un ajuste", () => {
    const result = checkPayoutAdjustment(18480, 18480, MOTIVO);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.field).toBe("netAmount");
  });

  it("solo pesos enteros, cero o más", () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = checkPayoutAdjustment(18480, value, MOTIVO);
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.field).toBe("netAmount");
    }
  });

  it("exige un motivo de al menos 10 caracteres, sin contar espacios de los bordes", () => {
    const corto = checkPayoutAdjustment(18480, 16000, "   corto    ");
    expect(corto.ok).toBe(false);
    expect(corto.ok ? null : corto.field).toBe("reason");
    expect(checkPayoutAdjustment(18480, 16000, "0123456789").ok).toBe(true);
  });
});

describe("adjustmentSummary", () => {
  it("dice las dos cifras", () => {
    expect(adjustmentSummary(18480, 16000)).toBe(
      `El trabajador recibirá ${clp(16000)} en vez de ${clp(18480)}.`,
    );
  });

  it("con $0 dice que se cancela", () => {
    expect(adjustmentSummary(18480, 0)).toBe(
      `Se cancela el pago de ${clp(18480)}: el trabajador no recibirá nada por este trabajo.`,
    );
  });
});
