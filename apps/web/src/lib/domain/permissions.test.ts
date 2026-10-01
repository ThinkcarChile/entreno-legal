import { describe, expect, it } from "vitest";

import { AssignmentStatus, JobStatus, PaymentStatus } from "./enums";
import { assignmentAbilities, nextWorkerStep, type AssignmentFacts } from "./permissions";

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
