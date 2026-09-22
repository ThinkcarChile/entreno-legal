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
}

export interface AdminPayout {
  payout: Payout;
  jobTitle: string;
  jobReference: string;
  workerName: string;
  completedAt: ISODateTime | null;
}

export interface AdminRepository {
  getKpis(): Promise<PlatformKpis>;
  listVerifications(status?: VerificationStatus): Promise<readonly VerificationRequest[]>;
  /** Cuántas cosas esperan una decisión ahora mismo. */
  getQueues(): Promise<AdminQueues>;
  listPendingCheckIns(): Promise<readonly PendingCheckIn[]>;
  listDisputes(onlyOpen?: boolean): Promise<readonly AdminDispute[]>;
  listPayouts(status?: PayoutStatus): Promise<readonly AdminPayout[]>;
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
