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
  /**
   * Hay una disputa ya RESUELTA. La administración cerró el caso: el trabajo
   * queda CLOSED y la base no admite otra disputa
   * (`guard_dispute_after_resolution`).
   */
  hasResolvedDispute: boolean;
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
const CANCELLED_ASSIGNMENT: readonly AssignmentStatus[] = [
  AssignmentStatus.CANCELLED_BY_CLIENT,
  AssignmentStatus.CANCELLED_BY_WORKER,
];
const CLOSED_ASSIGNMENT: readonly AssignmentStatus[] = [
  AssignmentStatus.COMPLETED,
  ...CANCELLED_ASSIGNMENT,
];

/**
 * ¿El pago del trabajo respalda que se trabaje? PAID, o PARTIALLY_REFUNDED: una
 * devolución parcial (un bono devuelto, una de buena voluntad) no deja el
 * trabajo sin pagar. Es la regla de la base (`job_payment_blocker`, y la que
 * usan `require_payment_before_work` y `job_evidence_open`). Devuelto entero,
 * en revisión, fallido o en curso, no.
 */
export function paymentBacksWork(status: PaymentStatus | null): boolean {
  return status === PaymentStatus.PAID || status === PaymentStatus.PARTIALLY_REFUNDED;
}

/**
 * ¿Este pago todavía se puede intentar? Sin pago, o con uno que no llegó a
 * cobrarse. Uno en revisión NO: el dinero pudo haber entrado, y pagar de nuevo
 * sería cobrar dos veces (`start_protected_payment` lo rechaza).
 */
export function paymentIsPayable(status: PaymentStatus | null): boolean {
  return (
    status === null ||
    status === PaymentStatus.PENDING ||
    status === PaymentStatus.CREATED ||
    status === PaymentStatus.FAILED
  );
}

/**
 * La administración cerró el trabajo al resolver una disputa. Es terminal: no
 * corre el tiempo, no se aporta evidencia ni se abre otra disputa, aunque la
 * asignación haya quedado IN_PROGRESS (`resolve_dispute` no la mueve).
 */
function closedByAdministration(f: AssignmentFacts): boolean {
  return f.jobStatus === JobStatus.CLOSED || f.hasResolvedDispute;
}

/** El trabajo está vivo y con dinero confirmado detrás. */
function isLive(f: AssignmentFacts): boolean {
  return (
    paymentBacksWork(f.paymentStatus) &&
    !CLOSED_ASSIGNMENT.includes(f.assignmentStatus) &&
    !closedByAdministration(f) &&
    f.jobStatus !== JobStatus.CANCELLED &&
    f.jobStatus !== JobStatus.CANCELLATION_PENDING &&
    f.jobStatus !== JobStatus.EXPIRED
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

    // El código de entrega vive en un solo estado: con el trabajo en curso. Es
    // el único desde el que la base admite pasar a HANDOFF_COMPLETED, y
    // `verify_handoff_code` rechaza —sin gastar intento— en cualquier otro.
    // Antes se ofrecía desde el check-in, donde acertar era imposible y
    // equivocarse sí sumaba intentos hasta bloquear el código 12 horas.
    canRequestHandoffCode: worker && live && !frozen && s === AssignmentStatus.IN_PROGRESS,

    canVerifyHandoffCode: worker && live && !frozen && s === AssignmentStatus.IN_PROGRESS,

    canRequestCompletion: worker && live && !frozen && s === AssignmentStatus.IN_PROGRESS,

    /* ------------------------------------------------------------ cliente */
    // Solo antes de comenzar y con un pago que todavía se puede intentar. Un
    // pago en revisión, devuelto o ya cobrado no se vuelve a pagar: antes
    // cualquier estado distinto de PAID ofrecía «Confirmar el pago», y
    // `/pagar` rebotaba o la base lo rechazaba.
    canPay:
      client &&
      s === AssignmentStatus.AWAITING_PAYMENT &&
      paymentIsPayable(f.paymentStatus) &&
      (f.jobStatus === JobStatus.OFFER_ACCEPTED || f.jobStatus === JobStatus.PAYMENT_PENDING),

    canAnswerExtension: client && live && !frozen && f.pendingExtension,

    // Mismo estado que la validación: un código generado antes de comenzar no
    // se podría usar.
    canGenerateHandoffCode: client && live && !frozen && s === AssignmentStatus.IN_PROGRESS,

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
    // es dentro de una disputa abierta, que tiene su propio expediente. Es la
    // misma pregunta que hace la base (`app_private.job_evidence_open`,
    // 20260601001820).
    canAddEvidence: (worker || client) && live && s !== AssignmentStatus.AWAITING_PAYMENT,

    // Reclamar necesita que haya habido trabajo y dinero, y que el plazo siga
    // abierto cuando el trabajo ya se aprobó. Una sola disputa por trabajo, y
    // ninguna con la transferencia al trabajador ya hecha: lo mismo que
    // `guard_dispute_after_resolution`.
    canOpenDispute:
      (worker || client) &&
      paymentBacksWork(f.paymentStatus) &&
      !f.hasOpenDispute &&
      !closedByAdministration(f) &&
      f.payoutStatus !== PayoutStatus.PAID &&
      s !== AssignmentStatus.AWAITING_PAYMENT &&
      !CANCELLED_ASSIGNMENT.includes(s) &&
      !(s === AssignmentStatus.COMPLETED && f.disputeWindowClosed),

    canAddDisputeEvidence: (worker || client || admin) && f.hasOpenDispute,

    // Se reseña un trabajo aprobado (la base exige COMPLETED), también si
    // después hubo una disputa ya resuelta. Uno que la administración cerró
    // antes de aprobarse no se reseña: la asignación nunca llega a COMPLETED.
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
  // Cerrado por la administración: la asignación puede seguir IN_PROGRESS en la
  // base, pero ya no hay nada en curso que esperar.
  if (closedByAdministration(f)) return "La administración resolvió la disputa y cerró el trabajo.";
  if (f.jobStatus === JobStatus.CANCELLATION_PENDING) {
    return "Estamos verificando el estado del pago antes de completar la cancelación.";
  }
  if (f.assignmentStatus === AssignmentStatus.AWAITING_PAYMENT) {
    return f.paymentStatus === PaymentStatus.UNDER_REVIEW
      ? "Estamos verificando el pago del cliente con el proveedor."
      : "Falta que el cliente confirme el pago.";
  }
  // Un pago puede volver de PAID a revisión, o devolverse entero, con el
  // trabajo ya en marcha: la base no deja avanzar, y la frase lo dice.
  if (!CLOSED_ASSIGNMENT.includes(f.assignmentStatus)) {
    if (f.paymentStatus === PaymentStatus.UNDER_REVIEW) {
      return "El pago del cliente está en revisión: el trabajo queda en pausa hasta que se resuelva.";
    }
    if (f.paymentStatus === PaymentStatus.REFUNDED) {
      return "El pago del cliente se devolvió: el trabajo no puede seguir.";
    }
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

/* --------------------------------------------------- tiempo adicional */

/**
 * Qué mostrarle al cliente del cobro de un tiempo adicional que aceptó.
 *
 *   paid        pagado
 *   payable     falta pagarlo, y todavía se puede
 *   closed      quedó sin pagar y ya no se puede: el pago al trabajador se
 *               cerró (transferido, cancelado o decidido en una disputa)
 *   in_flight   el proveedor todavía no responde
 *   in_review   el cobro está en revisión: no se vuelve a pagar
 *   refunded    el cobro se devolvió, entero o en parte
 *
 * Antes cualquier estado distinto de PAID mostraba «Falta pagar» con su botón:
 * también un cobro en revisión, uno devuelto, y el de un trabajo ya cerrado,
 * que la base rechaza (`start_extension_payment` solo cobra con el payout
 * PENDING, APPROVED o HELD y el trabajo sin cerrar).
 */
export type ExtensionPaymentView =
  | "paid"
  | "payable"
  | "closed"
  | "in_flight"
  | "in_review"
  | "refunded";

export interface ExtensionPaymentContext {
  jobStatus: JobStatus;
  assignmentStatus: AssignmentStatus;
  hasResolvedDispute: boolean;
  disputeWindowClosed: boolean;
  /**
   * El estado del payout si quien mira lo puede leer; `null` si no existe o
   * no lo puede leer, que es el caso del cliente (RLS de `payouts`).
   */
  payoutStatus: PayoutStatus | null;
}

/** Los estados del payout a los que todavía se le puede sumar un cobro. */
const PAYOUT_OPEN: readonly PayoutStatus[] = [
  PayoutStatus.PENDING,
  PayoutStatus.APPROVED,
  PayoutStatus.HELD,
];

/** ¿Un cobro adicional pagado ahora todavía llegaría al pago del trabajador? */
export function extensionStillPayable(ctx: ExtensionPaymentContext): boolean {
  if (
    ctx.hasResolvedDispute ||
    ctx.jobStatus === JobStatus.CLOSED ||
    ctx.jobStatus === JobStatus.CANCELLED ||
    ctx.jobStatus === JobStatus.CANCELLATION_PENDING ||
    ctx.jobStatus === JobStatus.EXPIRED ||
    CANCELLED_ASSIGNMENT.includes(ctx.assignmentStatus)
  ) {
    return false;
  }
  if (ctx.payoutStatus !== null) return PAYOUT_OPEN.includes(ctx.payoutStatus);
  // Sin ver el payout: no se transfiere ni se cancela antes de que venza el
  // plazo para reportar problemas o de que se resuelva una disputa
  // (`payout_transfer_blocker`), así que hasta entonces sigue abierto.
  return !(ctx.assignmentStatus === AssignmentStatus.COMPLETED && ctx.disputeWindowClosed);
}

export function extensionPaymentView(
  status: PaymentStatus | null,
  ctx: ExtensionPaymentContext,
): ExtensionPaymentView {
  switch (status) {
    case PaymentStatus.PAID:
      return "paid";
    case PaymentStatus.UNDER_REVIEW:
      return "in_review";
    case PaymentStatus.REFUNDED:
    case PaymentStatus.PARTIALLY_REFUNDED:
      return "refunded";
    case PaymentStatus.AUTHORIZED:
      return "in_flight";
    default:
      return extensionStillPayable(ctx) ? "payable" : "closed";
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
