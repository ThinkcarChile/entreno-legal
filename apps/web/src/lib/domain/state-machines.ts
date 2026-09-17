import {
  AssignmentStatus,
  DisputeStatus,
  ExtensionStatus,
  JobStatus,
  OfferStatus,
  PaymentStatus,
  PayoutStatus,
  VerificationStatus,
} from "./enums";

/**
 * Máquinas de estado explícitas.
 *
 * Ningún módulo cambia un estado sin consultar `canTransition`. Mantener las
 * transiciones como datos (y no como `if` dispersos) permite auditarlas, testearlas
 * y replicarlas como constraints en la base de datos.
 */

export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export const jobTransitions: TransitionMap<JobStatus> = {
  DRAFT: ["PUBLISHED", "CANCELLED"],
  PUBLISHED: ["OFFER_ACCEPTED", "CANCELLED", "EXPIRED"],
  OFFER_ACCEPTED: ["PAYMENT_PENDING", "PUBLISHED", "CANCELLED"],
  PAYMENT_PENDING: ["PAID", "PUBLISHED", "CANCELLED"],
  PAID: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["HANDOFF_COMPLETED", "COMPLETED", "DISPUTED", "CANCELLED"],
  HANDOFF_COMPLETED: ["COMPLETED", "DISPUTED"],
  COMPLETED: ["DISPUTED", "CLOSED"],
  DISPUTED: ["CLOSED"],
  CANCELLED: ["CLOSED"],
  EXPIRED: ["CLOSED"],
  CLOSED: [],
};

export const offerTransitions: TransitionMap<OfferStatus> = {
  PENDING: ["ACCEPTED", "REJECTED", "WITHDRAWN", "EXPIRED"],
  ACCEPTED: ["WITHDRAWN"],
  REJECTED: [],
  WITHDRAWN: [],
  EXPIRED: [],
};

export const assignmentTransitions: TransitionMap<AssignmentStatus> = {
  AWAITING_PAYMENT: ["CONFIRMED", "CANCELLED_BY_CLIENT", "CANCELLED_BY_WORKER"],
  CONFIRMED: ["ON_THE_WAY", "CANCELLED_BY_CLIENT", "CANCELLED_BY_WORKER"],
  ON_THE_WAY: ["CHECKED_IN", "CANCELLED_BY_CLIENT", "CANCELLED_BY_WORKER"],
  CHECKED_IN: ["IN_PROGRESS", "CANCELLED_BY_CLIENT", "CANCELLED_BY_WORKER"],
  IN_PROGRESS: ["HANDOFF_COMPLETED", "COMPLETED", "CANCELLED_BY_CLIENT", "CANCELLED_BY_WORKER"],
  HANDOFF_COMPLETED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED_BY_CLIENT: [],
  CANCELLED_BY_WORKER: [],
};

export const extensionTransitions: TransitionMap<ExtensionStatus> = {
  PENDING: ["ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
  ACCEPTED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export const paymentTransitions: TransitionMap<PaymentStatus> = {
  PENDING: ["CREATED", "FAILED"],
  CREATED: ["AUTHORIZED", "FAILED", "UNDER_REVIEW"],
  AUTHORIZED: ["PAID", "FAILED", "UNDER_REVIEW"],
  PAID: ["REFUNDED", "PARTIALLY_REFUNDED", "UNDER_REVIEW"],
  FAILED: ["PENDING"],
  REFUNDED: [],
  PARTIALLY_REFUNDED: ["REFUNDED"],
  UNDER_REVIEW: ["PAID", "REFUNDED", "PARTIALLY_REFUNDED", "FAILED"],
};

export const payoutTransitions: TransitionMap<PayoutStatus> = {
  PENDING: ["APPROVED", "HELD", "CANCELLED"],
  APPROVED: ["PROCESSING", "HELD", "CANCELLED"],
  PROCESSING: ["PAID", "HELD"],
  PAID: [],
  HELD: ["APPROVED", "CANCELLED"],
  CANCELLED: [],
};

export const verificationTransitions: TransitionMap<VerificationStatus> = {
  UNVERIFIED: ["PENDING"],
  PENDING: ["VERIFIED", "REJECTED"],
  VERIFIED: ["SUSPENDED"],
  REJECTED: ["PENDING"],
  SUSPENDED: ["PENDING", "VERIFIED"],
};

export const disputeTransitions: TransitionMap<DisputeStatus> = {
  OPEN: ["UNDER_REVIEW", "WITHDRAWN"],
  UNDER_REVIEW: ["RESOLVED"],
  RESOLVED: [],
  WITHDRAWN: [],
};

export function canTransition<S extends string>(
  map: TransitionMap<S>,
  from: S,
  to: S,
): boolean {
  return map[from]?.includes(to) ?? false;
}

export class InvalidTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Transición inválida en ${entity}: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition<S extends string>(
  entity: string,
  map: TransitionMap<S>,
  from: S,
  to: S,
): void {
  if (!canTransition(map, from, to)) throw new InvalidTransitionError(entity, from, to);
}

/**
 * Regla dura del producto: no se puede iniciar un trabajo sin pago confirmado.
 * Se valida aquí y además con un CHECK en la base de datos.
 */
export function canWorkStart(jobStatus: JobStatus, paymentStatus: PaymentStatus | null): boolean {
  return jobStatus === JobStatus.PAID && paymentStatus === PaymentStatus.PAID;
}

/** Estados en los que el trabajo sigue visible para recibir ofertas. */
export const OPEN_JOB_STATUSES: readonly JobStatus[] = [JobStatus.PUBLISHED];

/** Estados considerados "activos" para el panel del trabajador. */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = [
  JobStatus.OFFER_ACCEPTED,
  JobStatus.PAYMENT_PENDING,
  JobStatus.PAID,
  JobStatus.IN_PROGRESS,
  JobStatus.HANDOFF_COMPLETED,
];

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  JobStatus.CLOSED,
  JobStatus.CANCELLED,
  JobStatus.EXPIRED,
];
