import type { Money } from "@/lib/utils/money";

import type {
  AssignmentStatus,
  CategoryGroup,
  DisputeResolution,
  DisputeStatus,
  EvidenceType,
  ExtensionStatus,
  JobObjectiveType,
  JobStatus,
  JobUrgency,
  LoyaltyTransactionType,
  MessageType,
  NotificationType,
  OfferStatus,
  PaymentPurpose,
  PaymentStatus,
  PayoutStatus,
  UserRole,
  VerificationStatus,
  WorkerLevel,
} from "./enums";

export type UUID = string;
/** ISO-8601 en UTC. */
export type ISODateTime = string;

/* ----------------------------------------------------------------- Personas */

/** Perfil público. Nunca contiene RUT, teléfono, dirección ni datos bancarios. */
export interface PublicProfile {
  id: UUID;
  firstName: string;
  /** Solo la inicial se muestra; el apellido completo no sale de la capa privada. */
  lastNameInitial: string | null;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  city: string | null;
  regionCode: string | null;
  memberSince: ISODateTime;
  roles: readonly UserRole[];
}

/** Datos personales sensibles. Solo titular y administración. */
export interface PrivateUserData {
  userId: UUID;
  legalFirstName: string;
  legalLastName: string;
  rut: string | null;
  phone: string | null;
  contactEmail: string | null;
  birthDate: string | null;
  addressLine: string | null;
}

export interface TrustSignals {
  identityVerified: boolean;
  phoneVerified: boolean;
  bankAccountVerified: boolean;
  emailVerified: boolean;
}

export interface ReputationSnapshot {
  averageRating: number;
  reviewCount: number;
  completedJobs: number;
  workedMinutes: number;
  /** 0..1 */
  punctualityRate: number;
  /** 0..1 */
  completionRate: number;
  cancellationCount: number;
  /** 0..1 */
  communicationRate: number;
  /** Días desde el registro. */
  accountAgeDays: number;
  responseMinutesMedian: number | null;
}

export interface WorkerProfile {
  userId: UUID;
  profile: PublicProfile;
  headline: string | null;
  verificationStatus: VerificationStatus;
  level: WorkerLevel;
  /** Índice de Confianza HagoTuFila, 0..100. */
  trustIndex: number;
  baseHourlyRate: Money;
  categories: readonly UUID[];
  serviceAreas: readonly WorkerServiceArea[];
  availabilityNote: string | null;
  acceptsOvernight: boolean;
  reputation: ReputationSnapshot;
  trust: TrustSignals;
  isAcceptingJobs: boolean;
}

export interface WorkerServiceArea {
  id: UUID;
  workerId: UUID;
  regionCode: string;
  communeCode: string | null;
  radiusKm: number | null;
}

/* --------------------------------------------------------------- Categorías */

export interface JobCategory {
  id: UUID;
  slug: string;
  group: CategoryGroup;
  name: string;
  description: string | null;
  icon: string | null;
  /** Rango base sugerido por hora, antes de multiplicadores. */
  baseHourlyMin: Money;
  baseHourlyMax: Money;
  sortOrder: number;
  isActive: boolean;
}

/* ---------------------------------------------------------------- Ubicación */

/** Dirección exacta. Solo llega al cliente, al trabajador asignado y a administración. */
export interface ExactLocation {
  addressLine: string;
  /** Referencia adicional: piso, acceso, punto de encuentro. */
  addressNotes: string | null;
  lat: number | null;
  lng: number | null;
}

/**
 * Ubicación de un trabajo.
 *
 * Lo público es comuna, región, nombre del lugar y un punto aproximado. La
 * dirección exacta viaja en `exact`, que es `null` mientras quien mira no tenga
 * derecho a verla. Así la interfaz no puede filtrarla por descuido: si no está,
 * no se puede pintar.
 */
export interface JobLocation {
  countryCode: string;
  regionCode: string;
  regionName: string;
  communeCode: string;
  communeName: string;
  placeName: string | null;
  /** Redondeado a ~1 km. Suficiente para situar el sector. */
  approxLat: number | null;
  approxLng: number | null;
  exact: ExactLocation | null;
}

/* ----------------------------------------------------------------- Objetivo */

export interface JobObjective {
  type: JobObjectiveType;
  /** Para WITHIN_FIRST_N. */
  targetPosition: number | null;
  description: string | null;
  /** Bono por objetivo. Separado del pago por trabajo: se paga solo si se cumple. */
  bonus: Money | null;
  bonusConditions: string | null;
}

/* ----------------------------------------------------------------- Trabajos */

export interface JobImage {
  id: UUID;
  jobId: UUID;
  storagePath: string;
  url: string;
  caption: string | null;
  sortOrder: number;
}

export interface Job {
  id: UUID;
  reference: string;
  clientId: UUID;
  client: PublicProfile;
  category: JobCategory;
  status: JobStatus;
  title: string;
  description: string;
  instructions: string | null;
  location: JobLocation;
  timezone: string;
  startsAt: ISODateTime;
  estimatedDurationMinutes: number;
  isOvernight: boolean;
  urgency: JobUrgency;
  objective: JobObjective;
  /** Presupuesto por hora propuesto por el cliente. Referencia, no precio final. */
  proposedHourlyRate: Money;
  /** Presupuesto total propuesto = tarifa por hora × duración estimada. */
  proposedTotal: Money;
  suggestedHourlyMin: Money;
  suggestedHourlyMax: Money;
  images: readonly JobImage[];
  offerCount: number;
  viewCount: number;
  publishedAt: ISODateTime | null;
  expiresAt: ISODateTime | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** Resumen para listados. Evita traer descripción completa e imágenes. */
export interface JobSummary {
  id: UUID;
  reference: string;
  title: string;
  status: JobStatus;
  categoryName: string;
  categoryGroup: CategoryGroup;
  communeName: string;
  regionName: string;
  startsAt: ISODateTime;
  timezone: string;
  estimatedDurationMinutes: number;
  isOvernight: boolean;
  urgency: JobUrgency;
  proposedHourlyRate: Money;
  proposedTotal: Money;
  bonus: Money | null;
  offerCount: number;
  clientDisplayName: string;
  clientAvatarUrl: string | null;
  publishedAt: ISODateTime | null;
}

/* ------------------------------------------------------------------ Ofertas */

export interface JobOffer {
  id: UUID;
  jobId: UUID;
  workerId: UUID;
  worker: WorkerProfile;
  status: OfferStatus;
  hourlyRate: Money;
  estimatedTotal: Money;
  message: string | null;
  estimatedArrivalAt: ISODateTime | null;
  createdAt: ISODateTime;
  respondedAt: ISODateTime | null;
}

/* -------------------------------------------------------------- Asignación */

export interface Assignment {
  id: UUID;
  jobId: UUID;
  offerId: UUID;
  workerId: UUID;
  clientId: UUID;
  status: AssignmentStatus;
  agreedHourlyRate: Money;
  agreedDurationMinutes: number;
  agreedTotal: Money;
  bonus: Money | null;
  bonusAwarded: boolean | null;
  startedAt: ISODateTime | null;
  checkedInAt: ISODateTime | null;
  handoffCompletedAt: ISODateTime | null;
  completedAt: ISODateTime | null;
  disputeDeadlineAt: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface JobExtension {
  id: UUID;
  assignmentId: UUID;
  requestedBy: UUID;
  status: ExtensionStatus;
  additionalMinutes: number;
  hourlyRate: Money;
  additionalAmount: Money;
  reason: string | null;
  paymentId: UUID | null;
  respondedAt: ISODateTime | null;
  expiresAt: ISODateTime;
  createdAt: ISODateTime;
}

/* -------------------------------------------------------------------- Pagos */

export interface Payment {
  id: UUID;
  jobId: UUID;
  assignmentId: UUID | null;
  extensionId: UUID | null;
  clientId: UUID;
  purpose: PaymentPurpose;
  status: PaymentStatus;
  /** Importe cobrado al cliente. */
  amount: Money;
  provider: string;
  /** Identificador de la transacción en el proveedor. Nunca datos de tarjeta. */
  providerTransactionId: string | null;
  authorizedAt: ISODateTime | null;
  paidAt: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface PaymentEvent {
  id: UUID;
  paymentId: UUID;
  fromStatus: PaymentStatus | null;
  toStatus: PaymentStatus;
  provider: string;
  /** Carga útil del proveedor, ya saneada. Nunca contiene PAN ni CVV. */
  payload: Record<string, unknown>;
  createdAt: ISODateTime;
}

export interface Payout {
  id: UUID;
  assignmentId: UUID;
  workerId: UUID;
  status: PayoutStatus;
  /** Monto bruto del servicio. */
  grossAmount: Money;
  /** Comisión de HagoTuFila. */
  commissionAmount: Money;
  /** Descuentos aplicados (por ejemplo, resultado de una disputa parcial). */
  discountAmount: Money;
  /** Bono por objetivo, si corresponde. */
  bonusAmount: Money;
  /** Retenciones o impuestos cuando corresponda. */
  taxWithheldAmount: Money;
  /** Monto final destinado al trabajador. */
  netAmount: Money;
  bankReference: string | null;
  approvedAt: ISODateTime | null;
  paidAt: ISODateTime | null;
  notes: string | null;
  createdAt: ISODateTime;
}

/* -------------------------------------------------------- Evidencia y chat */

export interface JobTimelineEntry {
  id: UUID;
  assignmentId: UUID;
  jobId: UUID;
  authorId: UUID | null;
  authorName: string | null;
  type: EvidenceType;
  title: string;
  body: string | null;
  imageUrl: string | null;
  lat: number | null;
  lng: number | null;
  /** Personas por delante en la fila, cuando aplica. */
  queueAhead: number | null;
  occurredAt: ISODateTime;
  createdAt: ISODateTime;
}

export interface Conversation {
  id: UUID;
  jobId: UUID;
  assignmentId: UUID | null;
  clientId: UUID;
  workerId: UUID;
  lastMessageAt: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface Message {
  id: UUID;
  conversationId: UUID;
  senderId: UUID | null;
  type: MessageType;
  body: string | null;
  imageUrl: string | null;
  readAt: ISODateTime | null;
  createdAt: ISODateTime;
}

/* ----------------------------------------------------------------- Reseñas */

export interface Review {
  id: UUID;
  assignmentId: UUID;
  authorId: UUID;
  authorName: string;
  authorAvatarUrl: string | null;
  subjectId: UUID;
  punctuality: number;
  communication: number;
  compliance: number;
  overall: number;
  comment: string | null;
  createdAt: ISODateTime;
}

/* ---------------------------------------------------------------- Disputas */

export interface Dispute {
  id: UUID;
  assignmentId: UUID;
  openedBy: UUID;
  status: DisputeStatus;
  reason: string;
  description: string;
  resolution: DisputeResolution | null;
  resolutionNotes: string | null;
  /** Monto reembolsado al cliente en una resolución parcial. */
  refundAmount: Money | null;
  resolvedBy: UUID | null;
  resolvedAt: ISODateTime | null;
  createdAt: ISODateTime;
}

/* -------------------------------------------------------------- FilaPuntos */

export interface LoyaltyAccount {
  userId: UUID;
  /** Saldo derivado del ledger. No es dinero ni es retirable. */
  balance: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  updatedAt: ISODateTime;
}

export interface LoyaltyTransaction {
  id: UUID;
  userId: UUID;
  type: LoyaltyTransactionType;
  /** Positivo acredita, negativo debita. */
  points: number;
  balanceAfter: number;
  jobId: UUID | null;
  description: string;
  createdAt: ISODateTime;
}

/* ----------------------------------------------------------- Notificaciones */

export interface AppNotification {
  id: UUID;
  userId: UUID;
  type: NotificationType;
  title: string;
  body: string;
  href: string | null;
  jobId: UUID | null;
  readAt: ISODateTime | null;
  createdAt: ISODateTime;
}

/* -------------------------------------------------------------- Auditoría */

export interface AuditLogEntry {
  id: UUID;
  actorId: UUID | null;
  actorRole: UserRole | null;
  action: string;
  entityType: string;
  entityId: UUID;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: ISODateTime;
}


/* ------------------------------------------------- Etapa 2: sesión y cuenta */

/** Lo que la aplicación necesita saber de quien está conectado. */
export interface SessionUser {
  id: UUID;
  email: string | null;
  profile: PublicProfile;
  /** Modos activos de la cuenta. Una cuenta puede tener los dos. */
  modes: readonly UserRole[];
  isAdmin: boolean;
  onboardingCompleted: boolean;
  /** Presente solo si la cuenta tiene el modo trabajador activo. */
  worker: WorkerProfile | null;
  unreadNotifications: number;
}

/** Datos que el usuario completa al terminar de registrarse. */
export interface OnboardingInput {
  firstName: string;
  lastName: string;
  phone: string;
  regionCode: string;
  communeCode: string;
  avatarUrl?: string | null;
  wantsClient: boolean;
  wantsWorker: boolean;
}

/* ----------------------------------------------- Etapa 2: mis trabajos */

/** Un trabajo visto por su dueño, con el estado de sus ofertas. */
export interface ClientJobSummary extends JobSummary {
  assignmentId: UUID | null;
  assignmentStatus: AssignmentStatus | null;
  workerDisplayName: string | null;
  workerAvatarUrl: string | null;
  paymentStatus: PaymentStatus | null;
}

/** Un trabajo visto por el trabajador que ofertó o fue asignado. */
export interface WorkerJobSummary extends JobSummary {
  offerId: UUID | null;
  offerStatus: OfferStatus | null;
  offerHourlyRate: Money | null;
  assignmentId: UUID | null;
  assignmentStatus: AssignmentStatus | null;
  paymentStatus: PaymentStatus | null;
}

/** Vista completa de un trabajo ya asignado, para la pantalla central. */
export interface AssignmentDetail {
  assignment: Assignment;
  job: Job;
  client: PublicProfile;
  worker: WorkerProfile;
  payment: Payment | null;
  conversationId: UUID | null;
  timeline: readonly JobTimelineEntry[];
  /** Desglose económico calculado en la base. */
  settlement: PaymentBreakdown;
}

/** Desglose que se muestra en la pantalla de Pago Protegido. */
export interface PaymentBreakdown {
  serviceAmount: Money;
  bonusAmount: Money;
  commissionAmount: Money;
  commissionBps: number;
  /** Lo que recibe el trabajador si cumple el objetivo. */
  workerReceives: Money;
  /** Lo que paga el cliente. */
  clientTotal: Money;
}

/* ----------------------------------------------------- Etapa 2: mensajería */

export interface ConversationSummary {
  id: UUID;
  jobId: UUID;
  jobTitle: string;
  jobStatus: JobStatus;
  assignmentId: UUID | null;
  isPrimary: boolean;
  /** La contraparte, sea el cliente o el trabajador. */
  counterpartId: UUID;
  counterpartName: string;
  counterpartAvatarUrl: string | null;
  lastMessage: string | null;
  lastMessageAt: ISODateTime | null;
  unreadCount: number;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: readonly Message[];
  /** Quién es el usuario actual dentro de esta conversación. */
  viewerRole: "client" | "worker";
}

/* ------------------------------------------------ Etapa 2: administración */

export interface VerificationRequest {
  id: UUID;
  userId: UUID;
  status: VerificationStatus;
  displayName: string;
  avatarUrl: string | null;
  documentType: string | null;
  documentPath: string | null;
  selfiePath: string | null;
  rejectionReason: string | null;
  createdAt: ISODateTime;
  reviewedAt: ISODateTime | null;
}

/** Configuración operacional viva en la base. */
export interface PlatformSettings {
  commissionBps: number;
  disputeWindowHours: number;
  minDurationMinutes: number;
  loyaltyPointsPer1000: number;
  currency: string;
}
