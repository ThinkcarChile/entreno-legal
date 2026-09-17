import type { CategoryGroup, JobUrgency } from "@/lib/domain/enums";
import type {
  AppNotification,
  Job,
  JobCategory,
  JobOffer,
  JobSummary,
  JobTimelineEntry,
  PublicProfile,
  Review,
  UUID,
  WorkerProfile,
} from "@/lib/domain/types";
import type { Money } from "@/lib/utils/money";

/**
 * Contratos de acceso a datos.
 *
 * La UI depende solo de estas interfaces. Existen dos implementaciones:
 * `demo` (datos de demostración en CLP) y `supabase` (producción). Cambiar de una a
 * otra no altera un solo componente.
 */

export interface Page<T> {
  items: readonly T[];
  total: number;
  limit: number;
  offset: number;
}

export type JobSort = "recent" | "starts_soon" | "budget_desc" | "budget_asc";

export interface JobFilters {
  query?: string;
  categoryGroup?: CategoryGroup;
  categoryIds?: readonly string[];
  regionCode?: string;
  communeCode?: string;
  /** Tarifa por hora mínima, en unidad mínima de la moneda. */
  minHourlyRate?: number;
  overnightOnly?: boolean;
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
  listOpen(filters?: JobFilters): Promise<Page<JobSummary>>;
  getById(id: UUID): Promise<Job | null>;
  getByReference(reference: string): Promise<Job | null>;
  listOffers(jobId: UUID): Promise<readonly JobOffer[]>;
  getTimeline(jobId: UUID): Promise<readonly JobTimelineEntry[]>;
  countByCategory(): Promise<Readonly<Record<string, number>>>;
}

export interface WorkerRepository {
  getByUserId(userId: UUID): Promise<WorkerProfile | null>;
  listFeatured(limit?: number): Promise<readonly WorkerProfile[]>;
  listReviews(workerId: UUID, limit?: number): Promise<readonly Review[]>;
}

export interface ProfileRepository {
  getPublicProfile(userId: UUID): Promise<PublicProfile | null>;
}

export interface NotificationRepository {
  listForUser(userId: UUID, limit?: number): Promise<readonly AppNotification[]>;
  unreadCount(userId: UUID): Promise<number>;
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

export interface AdminRepository {
  getKpis(): Promise<PlatformKpis>;
}

export interface DataAccess {
  readonly source: "demo" | "supabase";
  readonly categories: CategoryRepository;
  readonly jobs: JobRepository;
  readonly workers: WorkerRepository;
  readonly profiles: ProfileRepository;
  readonly notifications: NotificationRepository;
  readonly admin: AdminRepository;
}
