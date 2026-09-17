/**
 * Enumeraciones de dominio.
 *
 * Cada valor coincide exactamente con el enum equivalente en PostgreSQL
 * (ver `supabase/migrations`). Se declaran como objetos `as const` + tipo derivado
 * para tener valores en runtime y tipos exactos sin `enum` de TypeScript.
 */

export const UserRole = {
  CLIENT: "CLIENT",
  WORKER: "WORKER",
  ADMIN: "ADMIN",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const VerificationStatus = {
  UNVERIFIED: "UNVERIFIED",
  PENDING: "PENDING",
  VERIFIED: "VERIFIED",
  REJECTED: "REJECTED",
  SUSPENDED: "SUSPENDED",
} as const;
export type VerificationStatus = (typeof VerificationStatus)[keyof typeof VerificationStatus];

export const WorkerLevel = {
  NUEVO: "NUEVO",
  VERIFICADO: "VERIFICADO",
  PRO: "PRO",
  EXPERTO: "EXPERTO",
} as const;
export type WorkerLevel = (typeof WorkerLevel)[keyof typeof WorkerLevel];

export const JobStatus = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  OFFER_ACCEPTED: "OFFER_ACCEPTED",
  PAYMENT_PENDING: "PAYMENT_PENDING",
  PAID: "PAID",
  IN_PROGRESS: "IN_PROGRESS",
  HANDOFF_COMPLETED: "HANDOFF_COMPLETED",
  COMPLETED: "COMPLETED",
  DISPUTED: "DISPUTED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
  CLOSED: "CLOSED",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const JobUrgency = {
  FLEXIBLE: "FLEXIBLE",
  NORMAL: "NORMAL",
  URGENTE: "URGENTE",
} as const;
export type JobUrgency = (typeof JobUrgency)[keyof typeof JobUrgency];

export const JobObjectiveType = {
  HOLD_PLACE: "HOLD_PLACE",
  AS_FRONT_AS_POSSIBLE: "AS_FRONT_AS_POSSIBLE",
  WITHIN_FIRST_N: "WITHIN_FIRST_N",
  COMPLETE_ERRAND: "COMPLETE_ERRAND",
  CUSTOM: "CUSTOM",
} as const;
export type JobObjectiveType = (typeof JobObjectiveType)[keyof typeof JobObjectiveType];

export const OfferStatus = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
  EXPIRED: "EXPIRED",
} as const;
export type OfferStatus = (typeof OfferStatus)[keyof typeof OfferStatus];

export const AssignmentStatus = {
  AWAITING_PAYMENT: "AWAITING_PAYMENT",
  CONFIRMED: "CONFIRMED",
  ON_THE_WAY: "ON_THE_WAY",
  CHECKED_IN: "CHECKED_IN",
  IN_PROGRESS: "IN_PROGRESS",
  HANDOFF_COMPLETED: "HANDOFF_COMPLETED",
  COMPLETED: "COMPLETED",
  CANCELLED_BY_CLIENT: "CANCELLED_BY_CLIENT",
  CANCELLED_BY_WORKER: "CANCELLED_BY_WORKER",
} as const;
export type AssignmentStatus = (typeof AssignmentStatus)[keyof typeof AssignmentStatus];

export const ExtensionStatus = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
} as const;
export type ExtensionStatus = (typeof ExtensionStatus)[keyof typeof ExtensionStatus];

export const PaymentStatus = {
  PENDING: "PENDING",
  CREATED: "CREATED",
  AUTHORIZED: "AUTHORIZED",
  PAID: "PAID",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
  UNDER_REVIEW: "UNDER_REVIEW",
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const PaymentPurpose = {
  JOB: "JOB",
  EXTENSION: "EXTENSION",
  BONUS: "BONUS",
} as const;
export type PaymentPurpose = (typeof PaymentPurpose)[keyof typeof PaymentPurpose];

export const PayoutStatus = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  PROCESSING: "PROCESSING",
  PAID: "PAID",
  HELD: "HELD",
  CANCELLED: "CANCELLED",
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

export const DisputeStatus = {
  OPEN: "OPEN",
  UNDER_REVIEW: "UNDER_REVIEW",
  RESOLVED: "RESOLVED",
  WITHDRAWN: "WITHDRAWN",
} as const;
export type DisputeStatus = (typeof DisputeStatus)[keyof typeof DisputeStatus];

export const DisputeResolution = {
  WORKER_WINS: "WORKER_WINS",
  CLIENT_WINS: "CLIENT_WINS",
  PARTIAL: "PARTIAL",
} as const;
export type DisputeResolution = (typeof DisputeResolution)[keyof typeof DisputeResolution];

export const EvidenceType = {
  CHECK_IN: "CHECK_IN",
  PHOTO: "PHOTO",
  NOTE: "NOTE",
  LOCATION: "LOCATION",
  QUEUE_STATUS: "QUEUE_STATUS",
  HANDOFF: "HANDOFF",
  SYSTEM: "SYSTEM",
} as const;
export type EvidenceType = (typeof EvidenceType)[keyof typeof EvidenceType];

export const MessageType = {
  TEXT: "TEXT",
  IMAGE: "IMAGE",
  SYSTEM: "SYSTEM",
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const NotificationType = {
  NEW_OFFER: "NEW_OFFER",
  OFFER_ACCEPTED: "OFFER_ACCEPTED",
  JOB_PAID: "JOB_PAID",
  WORKER_ON_THE_WAY: "WORKER_ON_THE_WAY",
  CHECK_IN: "CHECK_IN",
  NEW_MESSAGE: "NEW_MESSAGE",
  EXTENSION_REQUESTED: "EXTENSION_REQUESTED",
  EXTENSION_ANSWERED: "EXTENSION_ANSWERED",
  JOB_FINISHED: "JOB_FINISHED",
  DISPUTE_OPENED: "DISPUTE_OPENED",
  PAYOUT_APPROVED: "PAYOUT_APPROVED",
  NEW_REVIEW: "NEW_REVIEW",
  VERIFICATION_UPDATED: "VERIFICATION_UPDATED",
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const LoyaltyTransactionType = {
  EARNED_JOB: "EARNED_JOB",
  EARNED_PROMO: "EARNED_PROMO",
  EARNED_REFERRAL: "EARNED_REFERRAL",
  REDEEMED_COMMISSION_DISCOUNT: "REDEEMED_COMMISSION_DISCOUNT",
  EXPIRED: "EXPIRED",
  ADJUSTMENT: "ADJUSTMENT",
} as const;
export type LoyaltyTransactionType =
  (typeof LoyaltyTransactionType)[keyof typeof LoyaltyTransactionType];

export const CategoryGroup = {
  FILA: "FILA",
  TRAMITE: "TRAMITE",
} as const;
export type CategoryGroup = (typeof CategoryGroup)[keyof typeof CategoryGroup];
