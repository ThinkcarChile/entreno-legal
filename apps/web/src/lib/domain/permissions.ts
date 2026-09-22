import {
  AssignmentStatus,
  CheckInResult,
  CheckInReview,
  DisputeStatus,
  ExtensionStatus,
  JobStatus,
  PaymentStatus,
  PayoutStatus,
} from "./enums";

/**
 * Qué puede hacer cada parte, en un solo sitio.
 *
 * Antes cada pantalla encadenaba sus propias condiciones: una comprobaba el
 * estado del trabajo, otra el de la asignación, otra el del pago. Cuando esas
 * condiciones divergen aparecen las dos formas de error que peor se ven —un
 * botón que no hace nada y una acción válida que no está por ninguna parte— y
 * ninguna de las dos la detecta el compilador.
 *
 * Aquí se decide una vez, a partir de los hechos: rol, estado del trabajo,
 * estado de la asignación, estado del pago, si hay disputa abierta y si hay una
 * extensión esperando respuesta.
 *
 * **Esto no es una frontera de seguridad.** Cada acción se vuelve a comprobar
 * en el servidor, dentro de una función `SECURITY DEFINER` que mira quién llama
 * y bajo qué bloqueo. Esta matriz decide qué se MUESTRA; la base decide qué se
 * PERMITE. Que las dos coincidan es lo que hace la interfaz honesta.
 */

export type Party = "client" | "worker" | "admin" | "visitor";

/** Los hechos de los que depende todo lo demás. */
export interface AssignmentFacts {
  party: Party;
  jobStatus: JobStatus;
  assignmentStatus: AssignmentStatus;
  paymentStatus: PaymentStatus | null;
  /** Hay una disputa OPEN o UNDER_REVIEW sobre este trabajo. */
  hasOpenDispute: boolean;
  /** Hay una extensión PENDING sin vencer. */
  pendingExtension: boolean;
  /** Existe un check-in verificado, o uno aprobado a mano. */
  hasValidCheckIn: boolean;
  /** Hay al menos un check-in esperando revisión. */
  hasCheckInUnderReview: boolean;
  /** Estado del pago al trabajador, si ya existe. */
  payoutStatus: PayoutStatus | null;
  /** El plazo para reclamar ya venció. */
  disputeWindowClosed: boolean;
  /** Ya dejó su reseña quien mira. */
  hasReviewed: boolean;
}

export interface AssignmentAbilities {
  /* Trabajador */
  canMarkOnTheWay: boolean;
  canCheckIn: boolean;
  canStartWork: boolean;
  canPostUpdate: boolean;
  canRequestExtension: boolean;
  canRequestHandoffCode: boolean;
  canVerifyHandoffCode: boolean;
  canRequestCompletion: boolean;

  /* Cliente */
  canPay: boolean;
  canAnswerExtension: boolean;
  canGenerateHandoffCode: boolean;
  canSeeHandoffCode: boolean;
  canApproveCompletion: boolean;
  canCancelJob: boolean;

  /* Ambos */
  canChat: boolean;
  canSeeExactAddress: boolean;
  canSeeEvidence: boolean;
  canAddEvidence: boolean;
  canOpenDispute: boolean;
  canAddDisputeEvidence: boolean;
  canReview: boolean;
}

const NOTHING: AssignmentAbilities = {
  canMarkOnTheWay: false,
  canCheckIn: false,
  canStartWork: false,
  canPostUpdate: false,
  canRequestExtension: false,
  canRequestHandoffCode: false,
  canVerifyHandoffCode: false,
  canRequestCompletion: false,
  canPay: false,
  canAnswerExtension: false,
  canGenerateHandoffCode: false,
  canSeeHandoffCode: false,
  canApproveCompletion: false,
  canCancelJob: false,
  canChat: false,
  canSeeExactAddress: false,
  canSeeEvidence: false,
  canAddEvidence: false,
  canOpenDispute: false,
  canAddDisputeEvidence: false,
  canReview: false,
};

/** Estados en los que la asignación terminó, de una manera u otra. */
const CLOSED_ASSIGNMENT: readonly AssignmentStatus[] = [
  AssignmentStatus.COMPLETED,
  AssignmentStatus.CANCELLED_BY_CLIENT,
  AssignmentStatus.CANCELLED_BY_WORKER,
];

/** El trabajo está vivo y con dinero confirmado detrás. */
function isLive(f: AssignmentFacts): boolean {
  return (
    f.paymentStatus === PaymentStatus.PAID &&
    !CLOSED_ASSIGNMENT.includes(f.assignmentStatus) &&
    f.jobStatus !== JobStatus.CANCELLED &&
    f.jobStatus !== JobStatus.CANCELLATION_PENDING &&
    f.jobStatus !== JobStatus.EXPIRED &&
    f.jobStatus !== JobStatus.CLOSED
  );
}

export function assignmentAbilities(f: AssignmentFacts): AssignmentAbilities {
  // Un tercero no ve nada de un trabajo asignado. Es lo mismo que dice RLS.
  if (f.party === "visitor") return NOTHING;

  const worker = f.party === "worker";
  const client = f.party === "client";
  const admin = f.party === "admin";
  const live = isLive(f);
  const s = f.assignmentStatus;

  // Con una disputa abierta el trabajo se congela: nadie avanza, nadie aprueba,
  // nadie cobra. Lo resuelve la administración.
  const frozen = f.hasOpenDispute;

  return {
    /* --------------------------------------------------------- trabajador */
    canMarkOnTheWay: worker && live && !frozen && s === AssignmentStatus.CONFIRMED,

    // Se puede repetir: un primer intento con mala señal no deja a nadie fuera.
    canCheckIn:
      worker &&
      live &&
      !frozen &&
      (s === AssignmentStatus.CONFIRMED ||
        s === AssignmentStatus.ON_THE_WAY ||
        (s === AssignmentStatus.CHECKED_IN && !f.hasValidCheckIn)),

    canStartWork:
      worker && live && !frozen && s === AssignmentStatus.CHECKED_IN && f.hasValidCheckIn,

    canPostUpdate:
      worker &&
      live &&
      (s === AssignmentStatus.CHECKED_IN ||
        s === AssignmentStatus.IN_PROGRESS ||
        s === AssignmentStatus.HANDOFF_COMPLETED),

    canRequestExtension:
      worker && live && !frozen && s === AssignmentStatus.IN_PROGRESS && !f.pendingExtension,

    canRequestHandoffCode:
      worker &&
      live &&
      !frozen &&
      (s === AssignmentStatus.CHECKED_IN || s === AssignmentStatus.IN_PROGRESS),

    canVerifyHandoffCode:
      worker &&
      live &&
      !frozen &&
      (s === AssignmentStatus.CHECKED_IN || s === AssignmentStatus.IN_PROGRESS),

    canRequestCompletion: worker && live && !frozen && s === AssignmentStatus.IN_PROGRESS,

    /* ------------------------------------------------------------ cliente */
    canPay:
      client &&
      f.paymentStatus !== PaymentStatus.PAID &&
      (f.jobStatus === JobStatus.OFFER_ACCEPTED || f.jobStatus === JobStatus.PAYMENT_PENDING),

    canAnswerExtension: client && live && !frozen && f.pendingExtension,

    canGenerateHandoffCode:
      client &&
      live &&
      !frozen &&
      (s === AssignmentStatus.CHECKED_IN || s === AssignmentStatus.IN_PROGRESS),

    canSeeHandoffCode: client,

    canApproveCompletion:
      client &&
      live &&
      !frozen &&
      (s === AssignmentStatus.HANDOFF_COMPLETED || s === AssignmentStatus.IN_PROGRESS),

    // Cancelar deja de ser posible en cuanto el dinero está confirmado: a
    // partir de ahí es reembolso o disputa, y lo dice `cancel_job`.
    canCancelJob:
      client &&
      (f.jobStatus === JobStatus.DRAFT ||
        f.jobStatus === JobStatus.PUBLISHED ||
        f.jobStatus === JobStatus.OFFER_ACCEPTED ||
        f.jobStatus === JobStatus.PAYMENT_PENDING),

    /* ------------------------------------------------------------- ambos */
    canChat:
      (worker || client) &&
      f.jobStatus !== JobStatus.CANCELLATION_PENDING &&
      f.jobStatus !== JobStatus.CLOSED,

    // La dirección exacta aparece con la asignación hecha, no antes.
    canSeeExactAddress: worker || client || admin,

    canSeeEvidence: worker || client || admin,

    // Mientras el trabajo está vivo, las dos partes aportan evidencia. Una vez
    // cerrado ya no se añade nada a la línea de tiempo: si hay algo que decir,
    // es dentro de una disputa abierta, que tiene su propio expediente.
    canAddEvidence:
      (worker || client) &&
      f.paymentStatus === PaymentStatus.PAID &&
      !CLOSED_ASSIGNMENT.includes(s),

    // Reclamar necesita que haya habido trabajo y dinero, y que el plazo siga
    // abierto cuando el trabajo ya se aprobó.
    canOpenDispute:
      (worker || client) &&
      f.paymentStatus === PaymentStatus.PAID &&
      !f.hasOpenDispute &&
      s !== AssignmentStatus.AWAITING_PAYMENT &&
      !(s === AssignmentStatus.COMPLETED && f.disputeWindowClosed),

    canAddDisputeEvidence: (worker || client || admin) && f.hasOpenDispute,

    canReview:
      (worker || client) && s === AssignmentStatus.COMPLETED && !f.hasReviewed && !frozen,
  };
}

/**
 * El único paso que la interfaz debe ofrecer ahora al trabajador.
 *
 * Devuelve `null` cuando no hay ninguno: es lo que evita el botón que no hace
 * nada. Las etiquetas son las que se ven en pantalla.
 */
export interface WorkerStep {
  id: "on_the_way" | "check_in" | "start" | "handoff" | "completion";
  label: string;
  description: string;
}

export function nextWorkerStep(
  f: AssignmentFacts,
  abilities = assignmentAbilities(f),
): WorkerStep | null {
  if (abilities.canMarkOnTheWay) {
    return {
      id: "on_the_way",
      label: "Voy en camino",
      description: "Le avisamos al cliente que ya saliste.",
    };
  }
  if (abilities.canCheckIn && f.assignmentStatus !== AssignmentStatus.CONFIRMED) {
    return {
      id: "check_in",
      label: f.hasCheckInUnderReview ? "Reintentar el check-in" : "Llegué al lugar",
      description: "Registramos la hora y comprobamos que estés en el lugar del trabajo.",
    };
  }
  if (abilities.canStartWork) {
    return {
      id: "start",
      label: "Comenzar el trabajo",
      description: "Desde aquí corre el tiempo acordado y puedes enviar actualizaciones.",
    };
  }
  if (abilities.canRequestCompletion) {
    return {
      id: "completion",
      label: "Terminé el trabajo",
      description: "El cliente revisa y aprueba. Tu pago se libera con su aprobación.",
    };
  }
  return null;
}

/** Qué está esperando el trabajo ahora mismo, en una frase. */
export function waitingFor(f: AssignmentFacts): string {
  if (f.hasOpenDispute) return "La administración está revisando la disputa.";
  if (f.jobStatus === JobStatus.CANCELLATION_PENDING) {
    return "Estamos verificando el estado del pago antes de completar la cancelación.";
  }
  if (f.assignmentStatus === AssignmentStatus.AWAITING_PAYMENT) {
    return "Falta que el cliente confirme el pago.";
  }
  if (f.pendingExtension) return "El cliente tiene que responder a la solicitud de más tiempo.";
  if (f.hasCheckInUnderReview && !f.hasValidCheckIn) {
    return "Estamos revisando la llegada registrada.";
  }
  switch (f.assignmentStatus) {
    case AssignmentStatus.CONFIRMED:
      return "El trabajador va a salir hacia el lugar.";
    case AssignmentStatus.ON_THE_WAY:
      return "El trabajador va en camino.";
    case AssignmentStatus.CHECKED_IN:
      return "El trabajador llegó y está por comenzar.";
    case AssignmentStatus.IN_PROGRESS:
      return "El trabajo está en curso.";
    case AssignmentStatus.HANDOFF_COMPLETED:
      return "Falta que el cliente apruebe el trabajo.";
    case AssignmentStatus.COMPLETED:
      return "Trabajo completado.";
    default:
      return "Trabajo cancelado.";
  }
}

/* ------------------------------------------------------------------ apoyo */

/** ¿La extensión sigue esperando respuesta? */
export function isExtensionPending(status: ExtensionStatus, expiresAt: string): boolean {
  return status === ExtensionStatus.PENDING && new Date(expiresAt).getTime() > Date.now();
}

/** ¿La disputa sigue sin resolverse? */
export function isDisputeOpen(status: DisputeStatus): boolean {
  return status === DisputeStatus.OPEN || status === DisputeStatus.UNDER_REVIEW;
}

/** ¿Este check-in habilita el comienzo del trabajo? */
export function checkInUnlocks(result: CheckInResult, review: CheckInReview): boolean {
  return result === CheckInResult.VERIFIED || review === CheckInReview.APPROVED;
}

/** ¿Este check-in está esperando que alguien lo mire? */
export function checkInNeedsReview(review: CheckInReview): boolean {
  return review === CheckInReview.PENDING;
}
