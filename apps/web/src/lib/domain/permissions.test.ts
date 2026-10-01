import { describe, expect, it } from "vitest";

import { AssignmentStatus, JobStatus, PaymentStatus, PayoutStatus } from "./enums";
import {
  assignmentAbilities,
  extensionPaymentView,
  nextWorkerStep,
  paymentBacksWork,
  waitingFor,
  type AssignmentFacts,
  type ExtensionPaymentContext,
} from "./permissions";

/**
 * El código de entrega: la interfaz y la base tienen que estar de acuerdo.
 *
 * `verify_handoff_code` solo puede cerrar la entrega con la asignación en
 * IN_PROGRESS (la máquina de estados no admite CHECKED_IN → HANDOFF_COMPLETED).
 * Antes la matriz ofrecía el código desde el check-in: el trabajador lo
 * escribía, acertar era imposible y cada fallo gastaba uno de los cinco
 * intentos. Estas pruebas fijan que el panel aparezca exactamente donde la base
 * lo admite (Q60–Q68 en supabase/tests/15_abuse_storage.sql).
 */

function facts(overrides: Partial<AssignmentFacts>): AssignmentFacts {
  return {
    party: "worker",
    jobStatus: JobStatus.PAID,
    assignmentStatus: AssignmentStatus.CONFIRMED,
    paymentStatus: PaymentStatus.PAID,
    hasOpenDispute: false,
    hasResolvedDispute: false,
    pendingExtension: false,
    hasValidCheckIn: false,
    hasCheckInUnderReview: false,
    payoutStatus: null,
    disputeWindowClosed: false,
    hasReviewed: false,
    ...overrides,
  };
}

const EVERY_STATUS = Object.values(AssignmentStatus);

describe("código de entrega", () => {
  it("el trabajador lo pide y lo valida solo con el trabajo en curso", () => {
    for (const status of EVERY_STATUS) {
      const can = assignmentAbilities(
        facts({
          party: "worker",
          assignmentStatus: status,
          hasValidCheckIn: true,
          jobStatus: status === AssignmentStatus.IN_PROGRESS ? JobStatus.IN_PROGRESS : JobStatus.PAID,
        }),
      );
      const expected = status === AssignmentStatus.IN_PROGRESS;
      expect({ status, verify: can.canVerifyHandoffCode }).toEqual({ status, verify: expected });
      expect({ status, request: can.canRequestHandoffCode }).toEqual({ status, request: expected });
    }
  });

  it("el cliente lo genera solo con el trabajo en curso", () => {
    for (const status of EVERY_STATUS) {
      const can = assignmentAbilities(
        facts({ party: "client", assignmentStatus: status, hasValidCheckIn: true }),
      );
      expect({ status, generate: can.canGenerateHandoffCode }).toEqual({
        status,
        generate: status === AssignmentStatus.IN_PROGRESS,
      });
    }
  });

  it("con la llegada verificada lo que toca es comenzar, no el código", () => {
    const f = facts({ assignmentStatus: AssignmentStatus.CHECKED_IN, hasValidCheckIn: true });
    const can = assignmentAbilities(f);
    expect(can.canVerifyHandoffCode).toBe(false);
    expect(can.canRequestHandoffCode).toBe(false);
    expect(nextWorkerStep(f)?.id).toBe("start");
  });

  it("una disputa abierta congela el código para las dos partes", () => {
    const worker = assignmentAbilities(
      facts({ assignmentStatus: AssignmentStatus.IN_PROGRESS, hasOpenDispute: true }),
    );
    const client = assignmentAbilities(
      facts({ party: "client", assignmentStatus: AssignmentStatus.IN_PROGRESS, hasOpenDispute: true }),
    );
    expect(worker.canVerifyHandoffCode).toBe(false);
    expect(worker.canRequestHandoffCode).toBe(false);
    expect(client.canGenerateHandoffCode).toBe(false);
  });

  it("sin el pago confirmado no hay código", () => {
    const can = assignmentAbilities(
      facts({ assignmentStatus: AssignmentStatus.IN_PROGRESS, paymentStatus: PaymentStatus.UNDER_REVIEW }),
    );
    expect(can.canVerifyHandoffCode).toBe(false);
  });

  it("nadie más que las partes ve el panel", () => {
    for (const party of ["admin", "visitor"] as const) {
      const can = assignmentAbilities(facts({ party, assignmentStatus: AssignmentStatus.IN_PROGRESS }));
      expect(can.canVerifyHandoffCode || can.canGenerateHandoffCode || can.canRequestHandoffCode).toBe(
        false,
      );
    }
  });
});

/**
 * Lo que la base deja tras una disputa resuelta: el trabajo CLOSED y la
 * asignación como estaba —`resolve_dispute` no la mueve—, normalmente
 * IN_PROGRESS, con el pago del trabajo PAID (a favor del trabajador), REFUNDED o
 * PARTIALLY_REFUNDED (devolución confirmada). Antes la matriz lo leía como un
 * trabajo en curso al que le faltaba el pago: «Ir al pago» al cliente,
 * formulario de disputa que la base rechaza, evidencia y reloj corriendo.
 */
describe("trabajo cerrado por la administración", () => {
  const cerrado = (overrides: Partial<AssignmentFacts>) =>
    facts({
      jobStatus: JobStatus.CLOSED,
      assignmentStatus: AssignmentStatus.IN_PROGRESS,
      hasResolvedDispute: true,
      hasValidCheckIn: true,
      ...overrides,
    });

  const pagos = [PaymentStatus.PAID, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED];

  it("nadie paga, ni reclama otra vez, ni aporta evidencia, ni avanza", () => {
    for (const party of ["client", "worker"] as const) {
      for (const paymentStatus of pagos) {
        const f = cerrado({ party, paymentStatus });
        const can = assignmentAbilities(f);
        expect({ party, paymentStatus, can }).toEqual({
          party,
          paymentStatus,
          can: expect.objectContaining({
            canPay: false,
            canOpenDispute: false,
            canAddEvidence: false,
            canPostUpdate: false,
            canRequestCompletion: false,
            canApproveCompletion: false,
            canGenerateHandoffCode: false,
            canVerifyHandoffCode: false,
            canRequestExtension: false,
            canChat: false,
          }),
        });
        expect(nextWorkerStep(f)).toBeNull();
      }
    }
  });

  it("lo que espera ya no es «en curso»", () => {
    for (const paymentStatus of pagos) {
      expect(waitingFor(cerrado({ paymentStatus }))).toBe(
        "La administración resolvió la disputa y cerró el trabajo.",
      );
    }
  });

  it("aprobado y después disputado: se puede reseñar, no volver a reclamar", () => {
    const can = assignmentAbilities(
      cerrado({ party: "client", assignmentStatus: AssignmentStatus.COMPLETED }),
    );
    expect(can.canReview).toBe(true);
    expect(can.canOpenDispute).toBe(false);
  });

  it("cerrado antes de aprobarse no se reseña: la base exige COMPLETED", () => {
    expect(assignmentAbilities(cerrado({ party: "client" })).canReview).toBe(false);
  });

  it("basta la disputa resuelta, aunque el trabajo todavía no se vea CLOSED", () => {
    const can = assignmentAbilities(cerrado({ party: "client", jobStatus: JobStatus.IN_PROGRESS }));
    expect(can.canOpenDispute).toBe(false);
    expect(can.canAddEvidence).toBe(false);
  });
});

describe("el estado del pago, entero", () => {
  it("un pago en revisión no se vuelve a pagar", () => {
    const f = facts({
      party: "client",
      jobStatus: JobStatus.PAYMENT_PENDING,
      assignmentStatus: AssignmentStatus.AWAITING_PAYMENT,
      paymentStatus: PaymentStatus.UNDER_REVIEW,
    });
    expect(assignmentAbilities(f).canPay).toBe(false);
    expect(waitingFor(f)).toBe("Estamos verificando el pago del cliente con el proveedor.");
  });

  it("sin pago, o con uno que no llegó a cobrarse, el cliente sí puede pagar", () => {
    const estados = [null, PaymentStatus.PENDING, PaymentStatus.CREATED, PaymentStatus.FAILED];
    for (const paymentStatus of estados) {
      const can = assignmentAbilities(
        facts({
          party: "client",
          jobStatus: JobStatus.OFFER_ACCEPTED,
          assignmentStatus: AssignmentStatus.AWAITING_PAYMENT,
          paymentStatus,
        }),
      );
      expect({ paymentStatus, canPay: can.canPay }).toEqual({ paymentStatus, canPay: true });
    }
  });

  it("una devolución parcial no deja el trabajo sin pagar", () => {
    expect(paymentBacksWork(PaymentStatus.PARTIALLY_REFUNDED)).toBe(true);
    const f = facts({
      assignmentStatus: AssignmentStatus.IN_PROGRESS,
      jobStatus: JobStatus.IN_PROGRESS,
      paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
      hasValidCheckIn: true,
    });
    const can = assignmentAbilities(f);
    expect(can.canAddEvidence).toBe(true);
    expect(can.canRequestCompletion).toBe(true);
    expect(can.canOpenDispute).toBe(true);
    expect(waitingFor(f)).toBe("El trabajo está en curso.");
  });

  it("con el pago en revisión a mitad del trabajo, nada avanza y lo dice", () => {
    const f = facts({
      assignmentStatus: AssignmentStatus.IN_PROGRESS,
      jobStatus: JobStatus.IN_PROGRESS,
      paymentStatus: PaymentStatus.UNDER_REVIEW,
    });
    expect(assignmentAbilities(f).canAddEvidence).toBe(false);
    expect(waitingFor(f)).toMatch(/en revisión/);
  });

  it("antes del pago no hay evidencia, aunque el pago ya figure PAID", () => {
    const can = assignmentAbilities(
      facts({ assignmentStatus: AssignmentStatus.AWAITING_PAYMENT, paymentStatus: PaymentStatus.PAID }),
    );
    expect(can.canAddEvidence).toBe(false);
  });

  it("con la transferencia al trabajador hecha no se abre una disputa", () => {
    const can = assignmentAbilities(
      facts({
        party: "client",
        assignmentStatus: AssignmentStatus.COMPLETED,
        jobStatus: JobStatus.COMPLETED,
        payoutStatus: PayoutStatus.PAID,
      }),
    );
    expect(can.canOpenDispute).toBe(false);
  });
});

describe("el cobro del tiempo adicional", () => {
  const ctx = (overrides: Partial<ExtensionPaymentContext> = {}): ExtensionPaymentContext => ({
    jobStatus: JobStatus.IN_PROGRESS,
    assignmentStatus: AssignmentStatus.IN_PROGRESS,
    hasResolvedDispute: false,
    disputeWindowClosed: false,
    payoutStatus: null,
    ...overrides,
  });

  it("se ofrece pagar mientras se puede y llegaría al trabajador", () => {
    expect(extensionPaymentView(null, ctx())).toBe("payable");
    expect(extensionPaymentView(PaymentStatus.FAILED, ctx())).toBe("payable");
    expect(
      extensionPaymentView(PaymentStatus.PENDING, ctx({ assignmentStatus: AssignmentStatus.COMPLETED })),
    ).toBe("payable");
  });

  it("en revisión, devuelto o en curso con el proveedor, no hay botón", () => {
    expect(extensionPaymentView(PaymentStatus.UNDER_REVIEW, ctx())).toBe("in_review");
    expect(extensionPaymentView(PaymentStatus.REFUNDED, ctx())).toBe("refunded");
    expect(extensionPaymentView(PaymentStatus.PARTIALLY_REFUNDED, ctx())).toBe("refunded");
    expect(extensionPaymentView(PaymentStatus.AUTHORIZED, ctx())).toBe("in_flight");
    expect(extensionPaymentView(PaymentStatus.PAID, ctx())).toBe("paid");
  });

  it("con el trabajo cerrado o el pago al trabajador cerrado, ya no", () => {
    expect(
      extensionPaymentView(
        PaymentStatus.PENDING,
        ctx({ jobStatus: JobStatus.CLOSED, hasResolvedDispute: true }),
      ),
    ).toBe("closed");
    expect(
      extensionPaymentView(
        PaymentStatus.PENDING,
        ctx({ assignmentStatus: AssignmentStatus.COMPLETED, disputeWindowClosed: true }),
      ),
    ).toBe("closed");
    for (const payoutStatus of [PayoutStatus.PAID, PayoutStatus.CANCELLED, PayoutStatus.PROCESSING]) {
      expect(extensionPaymentView(PaymentStatus.PENDING, ctx({ payoutStatus }))).toBe("closed");
    }
    for (const payoutStatus of [PayoutStatus.PENDING, PayoutStatus.APPROVED, PayoutStatus.HELD]) {
      expect(extensionPaymentView(PaymentStatus.PENDING, ctx({ payoutStatus }))).toBe("payable");
    }
  });
});
