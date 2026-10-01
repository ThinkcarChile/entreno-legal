import { describe, expect, it } from "vitest";

import { DisputeStatus, PayoutStatus } from "@/lib/domain/enums";

import {
  confirmedRefundsByDispute,
  disputePaymentId,
  isActionablePaymentFilter,
  isDisputeClosed,
  isPayoutClosed,
  orderByIds,
  parsePaymentFilter,
  parseUuidParam,
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

describe("filtros de /admin/pagos", () => {
  it("lee el filtro de la URL; lo desconocido es «Todos»", () => {
    expect(parsePaymentFilter("review")).toBe("review");
    expect(parsePaymentFilter(["pending", "all"])).toBe("pending");
    expect(parsePaymentFilter("refunded")).toBe("refunded");
    expect(parsePaymentFilter(undefined)).toBe("all");
    expect(parsePaymentFilter("REVIEW")).toBe("all");
    expect(parsePaymentFilter("cualquiera")).toBe("all");
  });

  it("«En revisión» y «Sin resolver» piden una acción; «Todos» y «Devueltos» son historial", () => {
    expect(isActionablePaymentFilter("review")).toBe(true);
    expect(isActionablePaymentFilter("pending")).toBe(true);
    expect(isActionablePaymentFilter("all")).toBe(false);
    expect(isActionablePaymentFilter("refunded")).toBe(false);
  });

  it("?pago= solo acepta un uuid", () => {
    const id = "C3000000-0000-4000-8000-000000000001";
    expect(parseUuidParam(id)).toBe(id.toLowerCase());
    expect(parseUuidParam([` ${id} `])).toBe(id.toLowerCase());
    expect(parseUuidParam("c3000000")).toBeNull();
    expect(parseUuidParam("c3000000-0000-4000-8000-000000000001,otra")).toBeNull();
    expect(parseUuidParam("")).toBeNull();
    expect(parseUuidParam(undefined)).toBeNull();
  });
});

describe("orderByIds", () => {
  it("devuelve las filas en el orden de la base, aunque lleguen por trozos desordenados", () => {
    const filas = [{ id: "c" }, { id: "a" }, { id: "b" }];
    expect(orderByIds(filas, ["a", "b", "c"], (f) => f.id).map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  it("una fila que no está en la lista va al final, sin perderse", () => {
    const filas = [{ id: "x" }, { id: "b" }, { id: "a" }];
    expect(orderByIds(filas, ["a", "b"], (f) => f.id).map((f) => f.id)).toEqual(["a", "b", "x"]);
  });
});

describe("el pago que devuelve una disputa", () => {
  it("el que se cobró, aunque haya un intento fallido más reciente", () => {
    expect(
      disputePaymentId([
        { id: "p-cobrado", status: "PAID", created_at: "2026-06-01T10:00:00Z" },
        { id: "p-fallido", status: "FAILED", created_at: "2026-06-02T10:00:00Z" },
      ]),
    ).toBe("p-cobrado");
  });

  it("entre dos cobrados, el más reciente; devuelto o en revisión también cuentan como cobrados", () => {
    expect(
      disputePaymentId([
        { id: "p-1", status: "REFUNDED", created_at: "2026-06-01T10:00:00Z" },
        { id: "p-2", status: "UNDER_REVIEW", created_at: "2026-06-03T10:00:00Z" },
        { id: "p-3", status: "PENDING", created_at: "2026-06-04T10:00:00Z" },
      ]),
    ).toBe("p-2");
  });

  it("si ninguno se cobró, el último; si no hay pagos, ninguno", () => {
    expect(
      disputePaymentId([
        { id: "p-1", status: "FAILED", created_at: "2026-06-01T10:00:00Z" },
        { id: "p-2", status: "PENDING", created_at: "2026-06-02T10:00:00Z" },
      ]),
    ).toBe("p-2");
    expect(disputePaymentId([])).toBeNull();
  });

  it("con la misma hora decide el id, como en la base (mayor primero)", () => {
    expect(
      disputePaymentId([
        { id: "a", status: "PAID", created_at: "2026-06-01T10:00:00Z" },
        { id: "b", status: "PAID", created_at: "2026-06-01T10:00:00Z" },
      ]),
    ).toBe("b");
  });
});
