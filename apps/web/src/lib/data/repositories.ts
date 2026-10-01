import type {
  CategoryGroup,
  CheckInResult,
  JobUrgency,
  PayoutStatus,
  VerificationStatus,
} from "@/lib/domain/enums";
import type {
  AppNotification,
  AssignmentDetail,
  ClientJobSummary,
  ConversationDetail,
  ConversationSummary,
  Dispute,
  DisputeEvidence,
  Earning,
  EarningsSummary,
  ISODateTime,
  Job,
  JobCategory,
  JobOffer,
  JobSummary,
  JobTimelineEntry,
  Payout,
  PlatformSettings,
  PublicProfile,
  Review,
  SessionUser,
  UUID,
  VerificationRequest,
  WorkerJobSummary,
  WorkerProfile,
} from "@/lib/domain/types";
import type { Money } from "@/lib/utils/money";

import type { ActionablePaymentFilter, PaymentFilter, PaymentHistoryFilter } from "./admin-queues";

/**
 * Contratos de acceso a datos.
 *
 * La UI depende solo de estas interfaces. Existen dos implementaciones:
 * `demo` (datos de demostración en CLP, solo lectura) y `supabase` (real).
 *
 * Regla de seguridad que se nota en las firmas: ningún método recibe el
 * identificador del usuario que consulta. Quién pregunta lo determina la sesión,
 * nunca un parámetro que se pueda cambiar desde fuera.
 */

export interface Page<T> {
  items: readonly T[];
  total: number;
  limit: number;
  offset: number;
}

export type JobSort = "recent" | "starts_soon" | "budget_desc" | "budget_asc" | "duration_asc";

export interface JobFilters {
  query?: string;
  categoryGroup?: CategoryGroup;
  categoryIds?: readonly string[];
  regionCode?: string;
  communeCode?: string;
  /** Tarifa por hora mínima, en unidad mínima de la moneda. */
  minHourlyRate?: number;
  /** Presupuesto total mínimo. */
  minTotal?: number;
  /** Duración máxima en minutos. */
  maxDurationMinutes?: number;
  /** Trabajos que comienzan desde esta fecha (ISO, solo día). */
  fromDate?: string;
  /** Trabajos que comienzan hasta esta fecha (ISO, solo día). */
  toDate?: string;
  overnightOnly?: boolean;
  withBonusOnly?: boolean;
  urgency?: JobUrgency;
  sort?: JobSort;
  limit?: number;
  offset?: number;
}

export interface CategoryRepository {
  list(): Promise<readonly JobCategory[]>;
  getById(id: UUID): Promise<JobCategory | null>;
  getBySlug(slug: string): Promise<JobCategory | null>;
}

export interface JobRepository {
  /** Trabajos abiertos, visibles para cualquiera. Nunca incluye dirección exacta. */
  listOpen(filters?: JobFilters): Promise<Page<JobSummary>>;
  /**
   * Un trabajo. La dirección exacta viene en `location.exact` solo si quien
   * consulta tiene derecho a verla; si no, llega en `null`.
   */
  getById(id: UUID): Promise<Job | null>;
  /**
   * Instrucciones del trabajo. Solo las reciben el cliente, el trabajador
   * asignado y la administración; a cualquier otro le llega `null`, igual que
   * si no hubiera. Solo para páginas privadas: la pública nunca las pide.
   */
  getInstructions(jobId: UUID): Promise<string | null>;
  listOffers(jobId: UUID): Promise<readonly JobOffer[]>;
  getTimeline(jobId: UUID): Promise<readonly JobTimelineEntry[]>;
  countByCategory(): Promise<Readonly<Record<string, number>>>;

  /** Trabajos publicados por el usuario de la sesión. */
  listMinePublished(): Promise<readonly ClientJobSummary[]>;
  /** Trabajos en los que el usuario de la sesión ofertó o fue asignado. */
  listMineAsWorker(): Promise<readonly WorkerJobSummary[]>;
  /** La oferta del usuario de la sesión para un trabajo, si existe. */
  getMyOffer(jobId: UUID): Promise<JobOffer | null>;

  /** Pantalla central del trabajo asignado. */
  getAssignment(assignmentId: UUID): Promise<AssignmentDetail | null>;
  getAssignmentByJob(jobId: UUID): Promise<AssignmentDetail | null>;
}

export interface WorkerRepository {
  getByUserId(userId: UUID): Promise<WorkerProfile | null>;
  listFeatured(limit?: number): Promise<readonly WorkerProfile[]>;
  listReviews(workerId: UUID, limit?: number): Promise<readonly Review[]>;
  /** Reseñas destacadas para la portada. En modo real vienen de la base. */
  listRecentReviews(limit?: number): Promise<readonly Review[]>;
}

export interface ProfileRepository {
  getPublicProfile(userId: UUID): Promise<PublicProfile | null>;
}

export interface SessionRepository {
  /** Usuario conectado, o `null`. Nunca acepta un identificador por parámetro. */
  getSessionUser(): Promise<SessionUser | null>;
}

export interface ConversationRepository {
  listMine(): Promise<readonly ConversationSummary[]>;
  getById(conversationId: UUID): Promise<ConversationDetail | null>;
}

export interface DisputeRepository {
  /**
   * Pruebas de una disputa, de la más antigua a la más reciente. Las leen las
   * dos partes del trabajo y la administración; a cualquier otro, RLS le
   * devuelve una lista vacía.
   */
  listEvidence(disputeId: UUID): Promise<readonly DisputeEvidence[]>;
}

export interface NotificationRepository {
  listMine(limit?: number): Promise<readonly AppNotification[]>;
  unreadCount(): Promise<number>;
}

export interface SettingsRepository {
  get(): Promise<PlatformSettings>;
}

export interface PlatformKpis {
  /** Volumen bruto transado. */
  gmv: Money;
  platformRevenue: Money;
  jobsPublished: number;
  jobsCompleted: number;
  averageTicket: Money;
  newUsers30d: number;
  activeWorkers: number;
  cancellations: number;
  openDisputes: number;
  /** 0..1 */
  successRate: number;
  pendingVerifications: number;
  pendingPayouts: number;
}

/** Colas de trabajo del panel interno. */
export interface AdminQueues {
  checkIns: number;
  disputes: number;
  payouts: number;
  refunds: number;
  extensions: number;
}

export interface PendingCheckIn {
  id: UUID;
  assignmentId: UUID;
  jobId: UUID;
  jobTitle: string;
  jobReference: string;
  workerName: string;
  result: CheckInResult;
  distanceM: number | null;
  reviewReason: string | null;
  occurredAt: ISODateTime;
}

export interface AdminDispute {
  dispute: Dispute;
  jobId: UUID;
  jobTitle: string;
  jobReference: string;
  clientName: string;
  workerName: string;
  amountHeld: Money | null;
  payoutStatus: PayoutStatus | null;
  /**
   * Lo que falta devolver al cliente de una disputa resuelta a su favor: el
   * importe de la resolución menos las devoluciones CONFIRMADAS con esa
   * disputa. `null` si no se le debe nada o si ya se devolvió todo.
   */
  refundPending: Money | null;
  /**
   * El cobro sobre el que se pide esa devolución: el primero con parte de la
   * deuda según la cola (el del trabajo, después el del tiempo adicional), o el
   * del trabajo si ya está todo pedido. A él lleva el enlace «Devolución
   * pendiente», aunque sea antiguo. `null` si no hay.
   */
  paymentId: UUID | null;
  /**
   * Pruebas aportadas a la disputa, de cualquiera de las partes o de la
   * administración. `null` si no se pudieron contar: no es lo mismo que cero.
   */
  evidenceCount: number | null;
}

export interface AdminPayout {
  payout: Payout;
  jobTitle: string;
  jobReference: string;
  workerName: string;
  completedAt: ISODateTime | null;
  /**
   * Fin del plazo para reportar problemas. Antes de esa hora la transferencia no
   * se registra (salvo que una disputa ya se haya resuelto): lo exige la base.
   */
  disputeDeadlineAt: ISODateTime | null;
  /** Si al leer el dato el plazo seguía abierto. Se calcula al consultar, no al pintar. */
  disputeWindowOpen: boolean;
}

/** Un pago visto desde administración. Nunca incluye el token. */
export interface AdminPayment {
  paymentId: UUID;
  jobId: UUID;
  assignmentId: UUID | null;
  jobReference: string;
  jobTitle: string;
  clientId: UUID;
  purpose: string;
  status: string;
  provider: string;
  environment: string | null;
  buyOrder: string | null;
  amount: number;
  refundedAmount: number;
  refundableAmount: number;
  providerStatus: string | null;
  responseCode: number | null;
  authorizationCode: string | null;
  cardLastDigits: string | null;
  paymentTypeCode: string | null;
  installments: number | null;
  vci: string | null;
  attempt: number;
  failureReason: string | null;
  reviewReason: string | null;
  createdAt: ISODateTime;
  paidAt: ISODateTime | null;
  capturedAt: ISODateTime | null;
  committedAt: ISODateTime | null;
  reconciledAt: ISODateTime | null;
  eventCount: number;
  refundCount: number;
  /**
   * La disputa de la asignación, para «Ver la disputa». NO es la que se liga
   * al devolver: la vista la pone en todos los cobros de la asignación, también
   * en el del tiempo adicional y con la disputa abierta. Esa es
   * `disputeRefundId`.
   */
  disputeId: UUID | null;
  payoutId: UUID | null;
  /**
   * Intentos de este pago que esperan a una persona: un cobro duplicado por
   * devolver, o uno que salió de la ventana con indicios de cobro.
   */
  attemptsInReview: number;
  /** Cuáles: número de intento, orden de compra y motivo. */
  attemptsReviewDetail: string | null;
  /** La devolución en curso o por confirmar, si la hay. Bloquea pedir otra. */
  openRefund: AdminOpenRefund | null;
  /**
   * Lo que falta PEDIR sobre este cobro de una disputa resuelta a favor del
   * cliente: su parte de lo que la disputa todavía debe, nunca más de lo que
   * este cobro puede devolver (`dispute_refund_allocation`, migración
   * 20260601001610). Cero si no hay nada. Es uno de los motivos de la cola
   * «En revisión».
   */
  disputeRefundPending: number;
  /**
   * La disputa de esa parte: la única a la que se liga una devolución pedida
   * desde la tarjeta de este cobro. `null` si no hay nada que pedir.
   */
  disputeRefundId: UUID | null;
  /**
   * Cada intento en revisión —también los ya devueltos— con su cobro y su
   * última devolución. Es lo que se devuelve desde el panel, contra el token
   * de ese intento y sin tocar el pago.
   */
  reviewAttempts: readonly AdminReviewAttempt[];
}

/** Un intento con un cobro que no es el del pago: duplicado o en revisión. */
export interface AdminReviewAttempt {
  attemptId: UUID;
  attempt: number;
  buyOrder: string;
  /** DOUBLE_CHARGE (cobro duplicado) o UNDER_REVIEW (vencido con indicios de cobro). */
  status: string;
  reviewReason: string | null;
  /** El cobro entero del intento: lo que se devuelve. */
  amount: number;
  /**
   * Es el intento cuyo dinero es el del pago (el vigente de un pago en
   * revisión): se devuelve con la devolución del pago, no con la suya.
   */
  backsPayment: boolean;
  /** Su devolución más reciente, si alguna vez se pidió. */
  refund: AdminAttemptRefund | null;
}

/** La devolución del cobro de un intento. */
export interface AdminAttemptRefund {
  refundId: UUID;
  status: "REQUESTED" | "UNKNOWN" | "CONFIRMED" | "FAILED" | "CANCELLED";
  kind: string | null;
  amount: number;
  requestedAt: ISODateTime;
  settledAt: ISODateTime | null;
  failureReason: string | null;
  unknownReason: string | null;
  lastCheckedAt: ISODateTime | null;
  lastCheckResult: string | null;
}

/** Una devolución sin resultado final, con lo que explica por qué. */
export interface AdminOpenRefund {
  refundId: UUID;
  /** REQUESTED: enviada y esperando respuesta. UNKNOWN: el banco no dio respuesta en firme. */
  status: "REQUESTED" | "UNKNOWN";
  amount: number;
  requestedAt: ISODateTime;
  /** Por qué no se sabe: timeout, network, provider_http_5xx… */
  unknownReason: string | null;
  lastCheckedAt: ISODateTime | null;
  /** Qué concluyó la última consulta automática que no pudo decidir. */
  lastCheckResult: string | null;
}

/** Filtro de la pantalla de pagos. */
export type AdminPaymentFilter = PaymentFilter;

/**
 * Una regla de invariante rota según la última pasada de las tareas
 * programadas (`app_private.check_invariants`, migración 20260601001520).
 */
export interface IntegrityAlert {
  alertId: UUID;
  /** La función que la delata, p. ej. `refund_invariant_violations`. */
  source: string;
  /** La regla, p. ej. `refunded_amount_mismatch`. */
  kind: string;
  violationCount: number;
  /** Hasta cinco identificadores de filas que la rompen. */
  sampleIds: readonly UUID[];
  firstSeenAt: ISODateTime;
  lastSeenAt: ISODateTime;
  lastNotifiedAt: ISODateTime | null;
  acknowledgedAt: ISODateTime | null;
  /** Nadie la marcó como vista, o tiene más casos que cuando se marcó. */
  unacknowledged: boolean;
}

export interface AdminRepository {
  getKpis(): Promise<PlatformKpis>;
  listVerifications(status?: VerificationStatus): Promise<readonly VerificationRequest[]>;
  /** Cuántas cosas esperan una decisión ahora mismo. */
  getQueues(): Promise<AdminQueues>;
  listPendingCheckIns(): Promise<readonly PendingCheckIn[]>;
  /**
   * Disputas que piden una acción —abiertas, en revisión, o resueltas con una
   * devolución pendiente—, de la más antigua a la más reciente y SIN tope: una
   * antigua no puede desaparecer de la única pantalla donde se atiende.
   */
  listActionableDisputes(): Promise<readonly AdminDispute[]>;
  /** Disputas resueltas o retiradas, de la más reciente a la más antigua, por páginas. */
  listDisputeHistory(page: { limit: number; offset: number }): Promise<Page<AdminDispute>>;
  /**
   * Payouts que piden una acción —todo lo que no está transferido ni
   * cancelado—, del más antiguo al más reciente y SIN tope.
   */
  listActionablePayouts(): Promise<readonly AdminPayout[]>;
  /** Payouts transferidos o cancelados, del más reciente al más antiguo, por páginas. */
  listPayoutHistory(page: { limit: number; offset: number }): Promise<Page<AdminPayout>>;
  /**
   * Pagos del cliente que piden una acción —«En revisión» (la misma cola que
   * cuenta `getQueues().refunds`) o «Sin resolver»—, del más antiguo al más
   * reciente y SIN tope.
   */
  listActionablePayments(filter: ActionablePaymentFilter): Promise<readonly AdminPayment[]>;
  /** «Todos» o «Devueltos», del más reciente al más antiguo, por páginas. */
  listPaymentHistory(
    filter: PaymentHistoryFilter,
    page: { limit: number; offset: number },
  ): Promise<Page<AdminPayment>>;
  /** Un pago, por antiguo que sea: a él llevan los enlaces de otras pantallas. */
  getPayment(paymentId: UUID): Promise<AdminPayment | null>;
  /** Reglas de invariante rotas ahora mismo. Vacía si no hay ninguna. */
  listIntegrityAlerts(): Promise<readonly IntegrityAlert[]>;
}

/** Las ganancias de un trabajador. */
export interface EarningsRepository {
  listMine(): Promise<readonly Earning[]>;
  summary(): Promise<EarningsSummary>;
}

export interface DataAccess {
  readonly source: "demo" | "supabase";
  readonly categories: CategoryRepository;
  readonly jobs: JobRepository;
  readonly workers: WorkerRepository;
  readonly profiles: ProfileRepository;
  readonly session: SessionRepository;
  readonly conversations: ConversationRepository;
  readonly disputes: DisputeRepository;
  readonly notifications: NotificationRepository;
  readonly settings: SettingsRepository;
  readonly admin: AdminRepository;
  readonly earnings: EarningsRepository;
}

/**
 * El modo demostración es de solo lectura. Cualquier escritura lo dice en voz
 * alta en vez de fingir que guardó algo.
 */
export class DemoModeError extends Error {
  constructor(action = "Esta acción") {
    super(
      `${action} necesita una base de datos real. Estás en modo demostración: ` +
        "configura Supabase para guardar cambios.",
    );
    this.name = "DemoModeError";
  }
}
