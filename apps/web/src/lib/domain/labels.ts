import {
  AssignmentStatus,
  DisputeStatus,
  ExtensionStatus,
  JobStatus,
  JobUrgency,
  OfferStatus,
  PaymentStatus,
  PayoutStatus,
  VerificationStatus,
  WorkerLevel,
} from "./enums";

/**
 * Textos de presentación en español chileno.
 *
 * Los enums viajan en inglés por la base y el código; el usuario nunca los ve crudos.
 * Nota de producto: aquí no se usa el término "escrow" en ningún caso.
 */

export type ToneName = "neutral" | "info" | "success" | "warning" | "danger";

export interface StatusLabel {
  label: string;
  tone: ToneName;
  description?: string;
}

export const jobStatusLabels: Record<JobStatus, StatusLabel> = {
  DRAFT: { label: "Borrador", tone: "neutral" },
  PUBLISHED: { label: "Recibiendo ofertas", tone: "info" },
  OFFER_ACCEPTED: { label: "Oferta aceptada", tone: "info", description: "Falta confirmar el pago" },
  PAYMENT_PENDING: { label: "Pago pendiente", tone: "warning" },
  CANCELLATION_PENDING: {
    label: "Cancelación en verificación",
    tone: "warning",
    description: "Estamos verificando el estado del pago antes de completar la cancelación",
  },
  PAID: { label: "Pago confirmado", tone: "success", description: "El trabajador puede comenzar" },
  IN_PROGRESS: { label: "En curso", tone: "info" },
  HANDOFF_COMPLETED: { label: "Entrega realizada", tone: "success" },
  COMPLETED: { label: "Completado", tone: "success" },
  DISPUTED: { label: "En revisión", tone: "danger" },
  CANCELLED: { label: "Cancelado", tone: "neutral" },
  EXPIRED: { label: "Expirado", tone: "neutral" },
  CLOSED: { label: "Cerrado", tone: "neutral" },
};

export const assignmentStatusLabels: Record<AssignmentStatus, StatusLabel> = {
  AWAITING_PAYMENT: { label: "Esperando pago", tone: "warning" },
  CONFIRMED: { label: "Confirmado", tone: "success" },
  ON_THE_WAY: { label: "En camino", tone: "info" },
  CHECKED_IN: { label: "Check-in realizado", tone: "info" },
  IN_PROGRESS: { label: "En curso", tone: "info" },
  HANDOFF_COMPLETED: { label: "Entrega completada", tone: "success" },
  COMPLETED: { label: "Completado", tone: "success" },
  CANCELLED_BY_CLIENT: { label: "Cancelado por el cliente", tone: "neutral" },
  CANCELLED_BY_WORKER: { label: "Cancelado por el trabajador", tone: "neutral" },
};

export const offerStatusLabels: Record<OfferStatus, StatusLabel> = {
  PENDING: { label: "Pendiente", tone: "info" },
  ACCEPTED: { label: "Aceptada", tone: "success" },
  REJECTED: { label: "Rechazada", tone: "neutral" },
  WITHDRAWN: { label: "Retirada", tone: "neutral" },
  EXPIRED: { label: "Expirada", tone: "neutral" },
};

export const extensionStatusLabels: Record<ExtensionStatus, StatusLabel> = {
  PENDING: { label: "Esperando respuesta", tone: "warning" },
  ACCEPTED: { label: "Aceptada", tone: "success" },
  REJECTED: { label: "Rechazada", tone: "danger" },
  EXPIRED: { label: "Expirada", tone: "neutral" },
  CANCELLED: { label: "Cancelada", tone: "neutral" },
};

export const paymentStatusLabels: Record<PaymentStatus, StatusLabel> = {
  PENDING: { label: "Pendiente", tone: "warning" },
  CREATED: { label: "Iniciado", tone: "info" },
  AUTHORIZED: { label: "Autorizado", tone: "info" },
  PAID: { label: "Pagado", tone: "success" },
  FAILED: { label: "Rechazado", tone: "danger" },
  REFUNDED: { label: "Devuelto", tone: "neutral" },
  PARTIALLY_REFUNDED: { label: "Devuelto parcialmente", tone: "neutral" },
  UNDER_REVIEW: { label: "En revisión para devolución", tone: "warning" },
};

export const payoutStatusLabels: Record<PayoutStatus, StatusLabel> = {
  PENDING: { label: "Pendiente", tone: "warning" },
  APPROVED: { label: "Aprobado", tone: "info" },
  PROCESSING: { label: "En proceso", tone: "info" },
  PAID: { label: "Transferido", tone: "success" },
  HELD: { label: "Retenido", tone: "danger" },
  CANCELLED: { label: "Cancelado", tone: "neutral" },
};

export const verificationStatusLabels: Record<VerificationStatus, StatusLabel> = {
  UNVERIFIED: { label: "Sin verificar", tone: "neutral" },
  PENDING: { label: "Verificación en revisión", tone: "warning" },
  VERIFIED: { label: "Identidad verificada", tone: "success" },
  REJECTED: { label: "Verificación rechazada", tone: "danger" },
  SUSPENDED: { label: "Cuenta suspendida", tone: "danger" },
};

export const disputeStatusLabels: Record<DisputeStatus, StatusLabel> = {
  OPEN: { label: "Abierta", tone: "warning" },
  UNDER_REVIEW: { label: "En revisión", tone: "info" },
  RESOLVED: { label: "Resuelta", tone: "success" },
  WITHDRAWN: { label: "Retirada", tone: "neutral" },
};

export const workerLevelLabels: Record<WorkerLevel, { label: string; description: string }> = {
  NUEVO: { label: "Nuevo", description: "Recién se sumó a la plataforma" },
  VERIFICADO: { label: "Verificado", description: "Identidad confirmada y primeros trabajos" },
  PRO: { label: "Pro", description: "Historial sólido y buena puntualidad" },
  EXPERTO: { label: "Experto", description: "Trayectoria destacada y máxima confianza" },
};

export const urgencyLabels: Record<JobUrgency, StatusLabel> = {
  FLEXIBLE: { label: "Flexible", tone: "neutral" },
  NORMAL: { label: "Normal", tone: "info" },
  URGENTE: { label: "Urgente", tone: "warning" },
};
