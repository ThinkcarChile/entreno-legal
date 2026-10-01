import { describe, expect, it } from "vitest";

import { workerBuckets } from "./buckets";
import { AssignmentStatus, JobStatus, OfferStatus, PaymentStatus } from "./enums";

import type { WorkerJobSummary } from "./types";

/** Solo los campos que miran los grupos; el resto no interviene. */
function job(overrides: Partial<WorkerJobSummary>): WorkerJobSummary {
  return {
    id: "j",
    status: JobStatus.IN_PROGRESS,
    offerId: "o",
    offerStatus: OfferStatus.ACCEPTED,
    assignmentId: "a",
    assignmentStatus: AssignmentStatus.IN_PROGRESS,
    paymentStatus: PaymentStatus.PAID,
    ...overrides,
  } as WorkerJobSummary;
}

function bucketOf(item: WorkerJobSummary): string[] {
  return workerBuckets([item])
    .filter((b) => b.items.length > 0)
    .map((b) => b.id);
}

describe("los grupos del trabajador", () => {
  it("un trabajo en curso está en curso", () => {
    expect(bucketOf(job({}))).toEqual(["en-curso"]);
  });

  /**
   * `resolve_dispute` cierra el trabajo (CLOSED) y deja la asignación como
   * estaba. Antes el trabajo seguía para siempre en «En curso».
   */
  it("cerrado por la administración con la asignación en curso, está terminado", () => {
    for (const paymentStatus of [
      PaymentStatus.PAID,
      PaymentStatus.REFUNDED,
      PaymentStatus.PARTIALLY_REFUNDED,
    ]) {
      expect(bucketOf(job({ status: JobStatus.CLOSED, paymentStatus }))).toEqual(["terminados"]);
    }
  });

  it("con la entrega registrada y cerrado, también", () => {
    expect(
      bucketOf(
        job({ status: JobStatus.CLOSED, assignmentStatus: AssignmentStatus.HANDOFF_COMPLETED }),
      ),
    ).toEqual(["terminados"]);
  });

  it("en disputa abierta sigue en su pestaña", () => {
    expect(bucketOf(job({ status: JobStatus.DISPUTED }))).toEqual(["en-curso", "en-disputa"]);
  });
});
