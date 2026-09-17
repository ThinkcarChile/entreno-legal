import { JobStatus } from "@/lib/domain/enums";
import { createClient } from "@/lib/supabase/server";
import { money } from "@/lib/utils/money";

import {
  mapCategory,
  mapJob,
  mapJobSummary,
  mapOffer,
  mapProfile,
  mapReview,
  mapWorkerProfile,
  type CategoryRow,
  type JobRow,
  type OfferRow,
  type ProfileRow,
  type ReviewRow,
  type WorkerProfileRow,
} from "./mappers";

import type {
  AdminRepository,
  CategoryRepository,
  DataAccess,
  JobFilters,
  JobRepository,
  NotificationRepository,
  Page,
  PlatformKpis,
  ProfileRepository,
  WorkerRepository,
} from "../repositories";
import type {
  AppNotification,
  Job,
  JobCategory,
  JobOffer,
  JobSummary,
  JobTimelineEntry,
  PublicProfile,
  Review,
  WorkerProfile,
} from "@/lib/domain/types";

/**
 * Implementación sobre Supabase.
 *
 * Todas las lecturas pasan por el cliente con clave anónima y quedan sujetas a RLS.
 * Ningún método acepta un identificador de usuario para "ver como otro": el usuario
 * lo determina la sesión, no un parámetro de la URL.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

const JOB_COLUMNS =
  "id,reference,client_id,category_id,status,title,description,instructions,country_code," +
  "region_code,commune_code,address_line,address_notes,place_name,lat,lng,timezone,starts_at," +
  "estimated_duration_minutes,urgency,objective_type,objective_target_position," +
  "objective_description,bonus_amount,bonus_conditions,hourly_rate,currency,offer_count," +
  "view_count,published_at,expires_at,created_at,updated_at,suggested_hourly_min,suggested_hourly_max";

const PROFILE_COLUMNS =
  "id,first_name,last_name_initial,avatar_url,bio,city,region_code,roles,created_at";

const WORKER_COLUMNS =
  "user_id,headline,verification_status,level,trust_index,base_hourly_rate,availability_note," +
  "accepts_overnight,is_accepting_jobs,identity_verified,phone_verified,bank_account_verified," +
  "email_verified,average_rating,review_count,completed_jobs,worked_minutes,punctuality_rate," +
  "completion_rate,cancellation_count,communication_rate,response_minutes_median";

class SupabaseCategoryRepository implements CategoryRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async list(): Promise<readonly JobCategory[]> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("job_categories")
      .select("*")
      .eq("is_active", true)
      .order("sort_order")
      .returns<CategoryRow[]>();

    if (error) throw error;
    return (data ?? []).map(mapCategory);
  }

  async getById(id: string): Promise<JobCategory | null> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("job_categories")
      .select("*")
      .eq("id", id)
      .maybeSingle<CategoryRow>();

    if (error) throw error;
    return data ? mapCategory(data) : null;
  }

  async getBySlug(slug: string): Promise<JobCategory | null> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("job_categories")
      .select("*")
      .eq("slug", slug)
      .maybeSingle<CategoryRow>();

    if (error) throw error;
    return data ? mapCategory(data) : null;
  }
}

class SupabaseJobRepository implements JobRepository {
  constructor(
    private readonly getClient: () => Promise<Client>,
    private readonly categories: CategoryRepository,
  ) {}

  async listOpen(filters: JobFilters = {}): Promise<Page<JobSummary>> {
    const supabase = await this.getClient();
    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;

    let query = supabase
      .from("jobs")
      .select(JOB_COLUMNS, { count: "exact" })
      .eq("status", JobStatus.PUBLISHED);

    if (filters.categoryIds?.length) query = query.in("category_id", [...filters.categoryIds]);
    if (filters.regionCode) query = query.eq("region_code", filters.regionCode);
    if (filters.communeCode) query = query.eq("commune_code", filters.communeCode);
    if (filters.urgency) query = query.eq("urgency", filters.urgency);
    if (filters.minHourlyRate) query = query.gte("hourly_rate", filters.minHourlyRate);
    if (filters.query) query = query.ilike("title", `%${filters.query}%`);

    switch (filters.sort ?? "recent") {
      case "starts_soon":
        query = query.order("starts_at", { ascending: true });
        break;
      case "budget_desc":
        query = query.order("hourly_rate", { ascending: false });
        break;
      case "budget_asc":
        query = query.order("hourly_rate", { ascending: true });
        break;
      default:
        query = query.order("published_at", { ascending: false, nullsFirst: false });
    }

    const { data, error, count } = await query
      .range(offset, offset + limit - 1)
      .returns<JobRow[]>();

    if (error) throw error;

    const jobs = await this.hydrate(supabase, data ?? []);
    let items = jobs.map(mapJobSummary);

    // El filtro por categoría agrupada y por nocturnidad se resuelve en memoria:
    // ambos dependen de datos derivados (grupo de categoría y zona horaria).
    if (filters.categoryGroup) {
      items = items.filter((j) => j.categoryGroup === filters.categoryGroup);
    }
    if (filters.overnightOnly) {
      items = items.filter((j) => j.isOvernight);
    }

    return { items, total: count ?? items.length, limit, offset };
  }

  async getById(id: string): Promise<Job | null> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("id", id)
      .maybeSingle<JobRow>();

    if (error) throw error;
    if (!data) return null;
    const [job] = await this.hydrate(supabase, [data]);
    return job ?? null;
  }

  async getByReference(reference: string): Promise<Job | null> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("reference", reference)
      .maybeSingle<JobRow>();

    if (error) throw error;
    if (!data) return null;
    const [job] = await this.hydrate(supabase, [data]);
    return job ?? null;
  }

  async listOffers(jobId: string): Promise<readonly JobOffer[]> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("job_offers")
      .select("*")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false })
      .returns<OfferRow[]>();

    if (error) throw error;
    const rows = data ?? [];
    if (rows.length === 0) return [];

    const workers = await loadWorkers(supabase, rows.map((r) => r.worker_id));
    return rows
      .map((row) => {
        const worker = workers.get(row.worker_id);
        return worker ? mapOffer(row, worker) : null;
      })
      .filter((o): o is JobOffer => o !== null);
  }

  async getTimeline(jobId: string): Promise<readonly JobTimelineEntry[]> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("job_evidence")
      .select("*")
      .eq("job_id", jobId)
      .order("occurred_at", { ascending: true })
      .returns<Record<string, unknown>[]>();

    if (error) throw error;

    return (data ?? []).map((row) => ({
      id: String(row.id),
      assignmentId: String(row.assignment_id ?? ""),
      jobId,
      authorId: (row.author_id as string | null) ?? null,
      authorName: (row.author_name as string | null) ?? null,
      type: row.evidence_type as JobTimelineEntry["type"],
      title: String(row.title ?? ""),
      body: (row.body as string | null) ?? null,
      imageUrl: (row.image_url as string | null) ?? null,
      lat: (row.lat as number | null) ?? null,
      lng: (row.lng as number | null) ?? null,
      queueAhead: (row.queue_ahead as number | null) ?? null,
      occurredAt: String(row.occurred_at),
      createdAt: String(row.created_at),
    }));
  }

  async countByCategory(): Promise<Readonly<Record<string, number>>> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("jobs")
      .select("category_id")
      .eq("status", JobStatus.PUBLISHED)
      .returns<{ category_id: string }[]>();

    if (error) throw error;
    const counts: Record<string, number> = {};
    for (const row of data ?? []) {
      counts[row.category_id] = (counts[row.category_id] ?? 0) + 1;
    }
    return counts;
  }

  private async hydrate(supabase: Client, rows: readonly JobRow[]): Promise<Job[]> {
    if (rows.length === 0) return [];

    const categories = await this.categories.list();
    const categoryById = new Map(categories.map((c) => [c.id, c]));

    const clientIds = [...new Set(rows.map((r) => r.client_id))];
    const { data: profiles, error } = await supabase
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .in("id", clientIds)
      .returns<ProfileRow[]>();

    if (error) throw error;
    const profileById = new Map((profiles ?? []).map((p) => [p.id, mapProfile(p)]));

    return rows
      .map((row) => {
        const category = categoryById.get(row.category_id);
        const client = profileById.get(row.client_id);
        if (!category || !client) return null;
        return mapJob(row, category, client);
      })
      .filter((j): j is Job => j !== null);
  }
}

async function loadWorkers(
  supabase: Client,
  userIds: readonly string[],
): Promise<Map<string, WorkerProfile>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();

  const [{ data: workers, error: workerError }, { data: profiles, error: profileError }] =
    await Promise.all([
      supabase.from("worker_profiles").select(WORKER_COLUMNS).in("user_id", unique)
        .returns<WorkerProfileRow[]>(),
      supabase.from("profiles").select(PROFILE_COLUMNS).in("id", unique)
        .returns<ProfileRow[]>(),
    ]);

  if (workerError) throw workerError;
  if (profileError) throw profileError;

  const profileById = new Map((profiles ?? []).map((p) => [p.id, mapProfile(p)]));
  const result = new Map<string, WorkerProfile>();

  for (const row of workers ?? []) {
    const profile = profileById.get(row.user_id);
    if (profile) result.set(row.user_id, mapWorkerProfile(row, profile));
  }
  return result;
}

class SupabaseWorkerRepository implements WorkerRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async getByUserId(userId: string): Promise<WorkerProfile | null> {
    const supabase = await this.getClient();
    const workers = await loadWorkers(supabase, [userId]);
    return workers.get(userId) ?? null;
  }

  async listFeatured(limit = 4): Promise<readonly WorkerProfile[]> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("worker_profiles")
      .select("user_id")
      .eq("is_accepting_jobs", true)
      .order("trust_index", { ascending: false })
      .limit(limit)
      .returns<{ user_id: string }[]>();

    if (error) throw error;
    const ids = (data ?? []).map((r) => r.user_id);
    const workers = await loadWorkers(supabase, ids);
    return ids.map((id) => workers.get(id)).filter((w): w is WorkerProfile => Boolean(w));
  }

  async listReviews(workerId: string, limit = 10): Promise<readonly Review[]> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("public_reviews")
      .select("*")
      .eq("subject_id", workerId)
      .order("created_at", { ascending: false })
      .limit(limit)
      .returns<ReviewRow[]>();

    if (error) throw error;
    return (data ?? []).map(mapReview);
  }
}

class SupabaseProfileRepository implements ProfileRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async getPublicProfile(userId: string): Promise<PublicProfile | null> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .eq("id", userId)
      .maybeSingle<ProfileRow>();

    if (error) throw error;
    return data ? mapProfile(data) : null;
  }
}

class SupabaseNotificationRepository implements NotificationRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async listForUser(userId: string, limit = 20): Promise<readonly AppNotification[]> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit)
      .returns<Record<string, unknown>[]>();

    if (error) throw error;
    return (data ?? []).map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      type: row.notification_type as AppNotification["type"],
      title: String(row.title),
      body: String(row.body),
      href: (row.href as string | null) ?? null,
      jobId: (row.job_id as string | null) ?? null,
      readAt: (row.read_at as string | null) ?? null,
      createdAt: String(row.created_at),
    }));
  }

  async unreadCount(userId: string): Promise<number> {
    const supabase = await this.getClient();
    const { count, error } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("read_at", null);

    if (error) throw error;
    return count ?? 0;
  }
}

class SupabaseAdminRepository implements AdminRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async getKpis(): Promise<PlatformKpis> {
    const supabase = await this.getClient();
    // La vista `admin_kpis` agrega los indicadores del panel y está protegida por RLS.
    const { data, error } = await supabase
      .from("admin_kpis")
      .select("*")
      .maybeSingle<Record<string, number>>();

    if (error) throw error;
    const row = data ?? {};

    return {
      gmv: money(row.gmv ?? 0),
      platformRevenue: money(row.platform_revenue ?? 0),
      jobsPublished: row.jobs_published ?? 0,
      jobsCompleted: row.jobs_completed ?? 0,
      averageTicket: money(row.average_ticket ?? 0),
      newUsers30d: row.new_users_30d ?? 0,
      activeWorkers: row.active_workers ?? 0,
      cancellations: row.cancellations ?? 0,
      openDisputes: row.open_disputes ?? 0,
      successRate: row.success_rate ?? 0,
      pendingVerifications: row.pending_verifications ?? 0,
      pendingPayouts: row.pending_payouts ?? 0,
    };
  }
}

export function createSupabaseDataAccess(): DataAccess {
  const getClient = () => createClient();
  const categories = new SupabaseCategoryRepository(getClient);

  return {
    source: "supabase",
    categories,
    jobs: new SupabaseJobRepository(getClient, categories),
    workers: new SupabaseWorkerRepository(getClient),
    profiles: new SupabaseProfileRepository(getClient),
    notifications: new SupabaseNotificationRepository(getClient),
    admin: new SupabaseAdminRepository(getClient),
  };
}
