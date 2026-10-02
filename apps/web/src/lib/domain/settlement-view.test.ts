import { describe, expect, it } from "vitest";

import { PaymentStatus } from "./enums";
import { settlementHeadline } from "./settlement-view";
import type { PaymentBreakdown } from "./types";

const clp = (amount: number) => ({ amount, currency: "CLP" as const });

const settlement = {
  serviceAmount: clp(18000),
  bonusAmount: clp(0),
  commissionBps: 1400,
  commissionAmount: clp(2520),
  clientTotal: clp(18000),
  workerReceives: clp(15480),
} as unknown as PaymentBreakdown;

describe("settlementHeadline", () => {
  it("suma el tiempo adicional cobrado a lo que pagó el cliente", () => {
    const h = settlementHeadline({
      settlement,
      payment: { status: PaymentStatus.PAID, amount: clp(18000) },
      extensionPayments: { e1: { status: PaymentStatus.PAID, amount: clp(18000) } },
      payout: { netAmount: clp(30960) },
    });
    expect(h.clientCharged.amount).toBe(36000);
    expect(h.extensionCharged.amount).toBe(18000);
    expect(h.workerReceives.amount).toBe(30960);
    expect(h.fromPayout).toBe(true);
  });

  it("una extensión sin pagar no suma", () => {
    const h = settlementHeadline({
      settlement,
      payment: { status: PaymentStatus.PAID, amount: clp(18000) },
      extensionPayments: { e1: { status: PaymentStatus.PENDING, amount: clp(9000) } },
      payout: null,
    });
    expect(h.clientCharged.amount).toBe(18000);
    expect(h.workerReceives.amount).toBe(15480);
    expect(h.fromPayout).toBe(false);
  });

  it("el trabajador ve el payout ajustado o resuelto, no lo acordado", () => {
    const h = settlementHeadline({
      settlement,
      payment: { status: PaymentStatus.PARTIALLY_REFUNDED, amount: clp(18000) },
      extensionPayments: {},
      payout: { netAmount: clp(7480) },
    });
    expect(h.workerReceives.amount).toBe(7480);
    expect(h.clientCharged.amount).toBe(18000);
  });

  it("antes de pagar muestra lo acordado", () => {
    const h = settlementHeadline({ settlement, payment: null, extensionPayments: {}, payout: null });
    expect(h.clientCharged.amount).toBe(18000);
  });
});
