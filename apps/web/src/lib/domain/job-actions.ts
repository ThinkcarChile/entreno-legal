import { AssignmentStatus, JobStatus } from "./enums";

/**
 * Qué puede hacer cada parte según el estado. Una sola fuente.
 *
 * Los componentes preguntan aquí en vez de encadenar condiciones propias, para
 * que no aparezcan botones imposibles ni queden acciones válidas escondidas.
 *
 * Vocabulario de producto ↔ enum de la base:
 *   OPEN     → PUBLISHED
 *   ASSIGNED → OFFER_ACCEPTED
 *   READY    → PAID
 */

export type Viewer = "client" | "worker" | "visitor";

export interface JobPermissions {
  /** El cliente puede editar los campos del trabajo. */
  canEdit: boolean;
  /** El cliente puede cancelar el trabajo. */
  canCancel: boolean;
  /** El trabajo sigue recibiendo ofertas. */
  canReceiveOffers: boolean;
  /** El cliente puede aceptar una oferta. */
  canAcceptOffer: boolean;
  /** Falta pagar para que el trabajo arranque. */
  needsPayment: boolean;
  /** El trabajador puede empezar a moverse. */
  canStartWork: boolean;
  /** Se puede conversar. */
  canChat: boolean;
}

/** Estados en los que el trabajo aparece en el listado público. */
export function isOpen(status: JobStatus): boolean {
  return status === JobStatus.PUBLISHED;
}

/** Ya hay un trabajador elegido, pagado o no. */
export function isAssigned(status: JobStatus): boolean {
  return (
    status === JobStatus.OFFER_ACCEPTED ||
    status === JobStatus.PAYMENT_PENDING ||
    status === JobStatus.PAID ||
    status === JobStatus.IN_PROGRESS ||
    status === JobStatus.HANDOFF_COMPLETED
  );
}

export function isFinished(status: JobStatus): boolean {
  return (
    status === JobStatus.COMPLETED ||
    status === JobStatus.CLOSED ||
    status === JobStatus.CANCELLED ||
    status === JobStatus.EXPIRED
  );
}

/**
 * El cliente pidió cancelar mientras había un pago en vuelo y se espera la
 * respuesta del proveedor. Nada se puede hacer con el trabajo en este estado:
 * ni pagar, ni cancelar otra vez, ni comenzar. Termina en CANCELLED.
 */
export function isCancellationPending(status: JobStatus): boolean {
  return status === JobStatus.CANCELLATION_PENDING;
}

/** El trabajo todavía puede recibir un pago que lo habilite. */
export function isPayable(status: JobStatus): boolean {
  return status === JobStatus.OFFER_ACCEPTED || status === JobStatus.PAYMENT_PENDING;
}

export function jobPermissions(status: JobStatus, viewer: Viewer): JobPermissions {
  const client = viewer === "client";
  const editable = status === JobStatus.DRAFT || status === JobStatus.PUBLISHED;

  return {
    canEdit: client && editable,
    canCancel:
      client &&
      (editable ||
        status === JobStatus.OFFER_ACCEPTED ||
        status === JobStatus.PAYMENT_PENDING),
    canReceiveOffers: isOpen(status),
    canAcceptOffer: client && isOpen(status),
    needsPayment: client && isPayable(status),
    canStartWork: viewer === "worker" && status === JobStatus.PAID,
    canChat: viewer !== "visitor" && !isFinished(status) && !isCancellationPending(status),
  };
}

/**
 * Siguiente paso que el trabajador puede registrar.
 * Devuelve `null` cuando no corresponde ninguna acción.
 */
export function nextWorkerStep(
  status: AssignmentStatus,
): { to: AssignmentStatus; label: string; description: string } | null {
  switch (status) {
    case AssignmentStatus.CONFIRMED:
      return {
        to: AssignmentStatus.ON_THE_WAY,
        label: "Voy en camino",
        description: "Le avisamos al cliente que ya saliste.",
      };
    case AssignmentStatus.ON_THE_WAY:
      return {
        to: AssignmentStatus.CHECKED_IN,
        label: "Llegué al lugar",
        description: "Queda registrado con hora. Es tu respaldo si hay un reclamo.",
      };
    case AssignmentStatus.CHECKED_IN:
      return {
        to: AssignmentStatus.IN_PROGRESS,
        label: "Comenzar el trabajo",
        description: "A partir de aquí puedes subir actualizaciones.",
      };
    default:
      return null;
  }
}

/** Etiqueta del estado del trabajo pensada para el trabajador. */
export function workerFacingStage(status: AssignmentStatus): string {
  switch (status) {
    case AssignmentStatus.AWAITING_PAYMENT:
      return "Esperando que el cliente pague";
    case AssignmentStatus.CONFIRMED:
      return "Confirmado, listo para comenzar";
    case AssignmentStatus.ON_THE_WAY:
      return "En camino";
    case AssignmentStatus.CHECKED_IN:
      return "En el lugar";
    case AssignmentStatus.IN_PROGRESS:
      return "Trabajo en curso";
    case AssignmentStatus.HANDOFF_COMPLETED:
      return "Entrega realizada";
    case AssignmentStatus.COMPLETED:
      return "Completado";
    default:
      return "Cancelado";
  }
}
