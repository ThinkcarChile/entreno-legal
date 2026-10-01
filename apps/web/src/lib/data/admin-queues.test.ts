import { describe, expect, it } from "vitest";

import { DisputeStatus, PayoutStatus } from "@/lib/domain/enums";

import {
  confirmedRefundsByDispute,
  isDisputeClosed,
  isPayoutClosed,
  pendingDisputeRefund,
  postgrestList,
} from "./admin-queues";

describe("qué pide una acción", () => {
  it("un payout pide acción hasta que se transfiere o se cancela", () => {
    expect(isPayoutClosed(PayoutStatus.PENDING)).toBe(false);
    expect(isPayoutClosed(PayoutStatus.APPROVED)).toBe(false);
    expect(isPayoutClosed(PayoutStatus.PROCESSING)).toBe(false);
    expect(isPayoutClosed(PayoutStatus.HELD)).toBe(false);
    expect(isPayoutClosed(PayoutStatus.PAID)).toBe(true);
    expect(isPayoutClosed(PayoutStatus.CANCELLED)).toBe(true);
  });

  it("un estado que no conocemos se trata como pendiente, que se ve siempre", () => {
    expect(isPayoutClosed("ESTADO_NUEVO")).toBe(false);
    expect(isDisputeClosed("ESTADO_NUEVO")).toBe(false);
  });

  it("una disputa abierta o en revisión pide acción; resuelta o retirada, no", () => {
    expect(isDisputeClosed(DisputeStatus.OPEN)).toBe(false);
    expect(isDisputeClosed(DisputeStatus.UNDER_REVIEW)).toBe(false);
    expect(isDisputeClosed(DisputeStatus.RESOLVED)).toBe(true);
    expect(isDisputeClosed(DisputeStatus.WITHDRAWN)).toBe(true);
  });

  it("arma la lista para PostgREST", () => {
    expect(postgrestList(["PAID", "CANCELLED"])).toBe("(PAID,CANCELLED)");
  });
});

describe("devoluciones de una disputa", () => {
  it("solo cuenta lo confirmado, por disputa", () => {
    const totals = confirmedRefundsByDispute([
      { dispute_id: "d1", amount: 5000, status: "CONFIRMED" },
      { dispute_id: "d1", amount: 3000, status: "CONFIRMED" },
      { dispute_id: "d1", amount: 9000, status: "REQUESTED" },
      { dispute_id: "d1", amount: 9000, status: "FAILED" },
      { dispute_id: "d2", amount: 1000, status: "UNKNOWN" },
      { dispute_id: null, amount: 7000, status: "CONFIRMED" },
    ]);
    expect(totals.get("d1")).toBe(8000);
    expect(totals.has("d2")).toBe(false);
  });

  it("lo pendiente es lo resuelto menos lo confirmado, nunca negativo", () => {
    expect(pendingDisputeRefund(18000, 0)).toBe(18000);
    expect(pendingDisputeRefund(18000, 8000)).toBe(10000);
    expect(pendingDisputeRefund(18000, 18000)).toBe(0);
    expect(pendingDisputeRefund(18000, 20000)).toBe(0);
  });

  it("sin importe a favor del cliente no hay nada pendiente", () => {
    expect(pendingDisputeRefund(null, 0)).toBe(0);
    expect(pendingDisputeRefund(0, 0)).toBe(0);
  });
});
