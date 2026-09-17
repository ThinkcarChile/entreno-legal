import { JobStatus } from "@/lib/domain/enums";
import { money } from "@/lib/utils/money";

import {
  mapAssignment,
  mapJob,
  mapJobSummary,
  mapOffer,
  mapPayment,
  mapPaymentBreakdown,
  mapProfile,
  mapWorkerProfile,
  type AssignmentRow,
  type JobPrivateLocationRow,
  type JobRow,
  type OfferRow,
  type PaymentRow,
  type PaymentSummaryRow,
  type ProfileRow,
  type WorkerProfileRow,
} from "./mappers";
import {
  ASSIGNMENT_COLUMNS,
  currentUserId,
  JOB_COLUMNS,
  PAYMENT_COLUMNS,
  PROFILE_COLUMNS,
  WORKER_COLUMNS,
  type Client,
} from "./shared";

import type { CategoryRepository, JobFilters, JobRepository, Page } from "../repositories";
import type {
  AssignmentDetail,
  ClientJobSummary,
  Job,
  JobOffer,
  JobSummary,
  JobTimelineEntry,
  WorkerJobSummary,
  WorkerProfile,
} from "@/lib/domain/types";

/**
 * Trabajos sobre Supabase.
 *
 * Todas las lecturas pasan por la clave anónima y quedan sujetas a RLS. La
 * dirección exacta se pide aparte, a `job_private_location`: si la política no
 * la deja pasar, simplemente no llega y el trabajo se arma sin ella.
 */
export class SupabaseJobRepository implements JobRepository {
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
    if (filters.maxDurationMinutes) {
      query = query.lte("estimated_duration_minutes", filters.maxDurationMinutes);
    }
    if (filters.withBonusOnly) query = query.gt("bonus_amount", 0);
    if (filters.fromDate) query = query.gte("starts_at", `${filters.fromDate}T00:00:00Z`);
    if (filters.toDate) query = query.lte("starts_at", `${filters.toDate}T23:59:59Z`);
    if (filters.query) {
      query = query.or(`title.ilike.%${filters.query}%,description.ilike.%${filters.query}%`);
    }

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
      case "duration_asc":
        query = query.order("estimated_duration_minutes", { ascending: true });
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

    // Grupo de categoría y nocturnidad son datos derivados: se filtran en memoria.
    if (filters.categoryGroup) {
      items = items.filter((j) => j.categoryGroup === filters.categoryGroup);
    }
    if (filters.overnightOnly) items = items.filter((j) => j.isOvernight);
    if (filters.minTotal) items = items.filter((j) => j.proposedTotal.amount >= filters.minTotal!);

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

    const [job] = await this.hydrate(supabase, [data], true);
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
    const [job] = await this.hydrate(supabase, [data], true);
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

  async getMyOffer(jobId: string): Promise<JobOffer | null> {
    const supabase = await this.getClient();
    const userId = await currentUserId(supabase);
    if (!userId) return null;

    const { data, error } = await supabase
      .from("job_offers")
      .select("*")
      .eq("job_id", jobId)
      .eq("worker_id", userId)
      .maybeSingle<OfferRow>();

    if (error) throw error;
    if (!data) return null;

    const workers = await loadWorkers(supabase, [userId]);
    const worker = workers.get(userId);
    return worker ? mapOffer(data, worker) : null;
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

  async listMinePublished(): Promise<readonly ClientJobSummary[]> {
    const supabase = await this.getClient();
    const userId = await currentUserId(supabase);
    if (!userId) return [];

    const { data, error } = await supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("client_id", userId)
      .order("created_at", { ascending: false })
      .returns<JobRow[]>();

    if (error) throw error;
    const jobs = await this.hydrate(supabase, data ?? []);
    if (jobs.length === 0) return [];

    const assignments = await loadAssignmentsByJob(supabase, jobs.map((j) => j.id));
    const workerIds = [...assignments.values()].map((a) => a.worker_id);
    const profiles = await loadProfiles(supabase, workerIds);
    const payments = await loadLatestPayments(
      supabase,
      [...assignments.values()].map((a) => a.id),
    );

    return jobs.map((job) => {
      const assignment = assignments.get(job.id);
      const profile = assignment ? profiles.get(assignment.worker_id) : undefined;
      const payment = assignment ? payments.get(assignment.id) : undefined;

      return {
        ...mapJobSummary(job),
        assignmentId: assignment?.id ?? null,
        assignmentStatus: (assignment?.status as ClientJobSummary["assignmentStatus"]) ?? null,
        workerDisplayName: profile?.displayName ?? null,
        workerAvatarUrl: profile?.avatarUrl ?? null,
        paymentStatus: (payment?.status as ClientJobSummary["paymentStatus"]) ?? null,
      };
    });
  }

  async listMineAsWorker(): Promise<readonly WorkerJobSummary[]> {
    const supabase = await this.getClient();
    const userId = await currentUserId(supabase);
    if (!userId) return [];

    const { data: offers, error: offersError } = await supabase
      .from("job_offers")
      .select("*")
      .eq("worker_id", userId)
      .order("created_at", { ascending: false })
      .returns<OfferRow[]>();

    if (offersError) throw offersError;
    const offerRows = offers ?? [];
    if (offerRows.length === 0) return [];

    const { data: jobRows, error: jobsError } = await supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .in("id", offerRows.map((o) => o.job_id))
      .returns<JobRow[]>();

    if (jobsError) throw jobsError;

    const jobs = await this.hydrate(supabase, jobRows ?? []);
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const assignments = await loadAssignmentsByJob(supabase, jobs.map((j) => j.id));
    const payments = await loadLatestPayments(
      supabase,
      [...assignments.values()].map((a) => a.id),
    );

    const result: WorkerJobSummary[] = [];

    for (const offer of offerRows) {
      const job = jobById.get(offer.job_id);
      if (!job) continue;

      const assignment = assignments.get(job.id);
      // Una asignación de otro trabajador no es asunto de quien solo ofertó.
      const mine = assignment?.worker_id === userId ? assignment : undefined;
      const payment = mine ? payments.get(mine.id) : undefined;

      result.push({
        ...mapJobSummary(job),
        offerId: offer.id,
        offerStatus: offer.status as WorkerJobSummary["offerStatus"],
        offerHourlyRate: money(offer.hourly_rate),
        assignmentId: mine?.id ?? null,
        assignmentStatus: (mine?.status as WorkerJobSummary["assignmentStatus"]) ?? null,
        paymentStatus: (payment?.status as WorkerJobSummary["paymentStatus"]) ?? null,
      });
    }

    return result;
  }

  async getAssignment(assignmentId: string): Promise<AssignmentDetail | null> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("assignments")
      .select(ASSIGNMENT_COLUMNS)
      .eq("id", assignmentId)
      .maybeSingle<AssignmentRow>();

    if (error) throw error;
    return data ? this.buildAssignmentDetail(supabase, data) : null;
  }

  async getAssignmentByJob(jobId: string): Promise<AssignmentDetail | null> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("assignments")
      .select(ASSIGNMENT_COLUMNS)
      .eq("job_id", jobId)
      .maybeSingle<AssignmentRow>();

    if (error) throw error;
    return data ? this.buildAssignmentDetail(supabase, data) : null;
  }

  private async buildAssignmentDetail(
    supabase: Client,
    row: AssignmentRow,
  ): Promise<AssignmentDetail | null> {
    const job = await this.getById(row.job_id);
    if (!job) return null;

    const [workers, profiles, paymentResult, summaryResult, conversationResult, timeline] =
      await Promise.all([
        loadWorkers(supabase, [row.worker_id]),
        loadProfiles(supabase, [row.client_id]),
        supabase
          .from("payments")
          .select(PAYMENT_COLUMNS)
          .eq("assignment_id", row.id)
          .eq("purpose", "JOB")
          .order("created_at", { ascending: false })
          .limit(1)
          .returns<PaymentRow[]>(),
        supabase
          .from("assignment_payment_summary")
          .select("*")
          .eq("assignment_id", row.id)
          .maybeSingle<PaymentSummaryRow>(),
        supabase
          .from("conversations")
          .select("id")
          .eq("job_id", row.job_id)
          .eq("worker_id", row.worker_id)
          .maybeSingle<{ id: string }>(),
        this.getTimeline(row.job_id),
      ]);

    const worker = workers.get(row.worker_id);
    const client = profiles.get(row.client_id);
    if (!worker || !client) return null;

    const payment = paymentResult.data?.[0] ? mapPayment(paymentResult.data[0]) : null;
    const summary = summaryResult.data;

    return {
      assignment: mapAssignment(row),
      job,
      client,
      worker,
      payment,
      conversationId: conversationResult.data?.id ?? null,
      timeline,
      settlement: summary
        ? mapPaymentBreakdown(summary)
        : {
            serviceAmount: mapAssignment(row).agreedTotal,
            bonusAmount: mapAssignment(row).bonus ?? { amount: 0, currency: "CLP" },
            commissionAmount: { amount: 0, currency: "CLP" },
            commissionBps: 0,
            workerReceives: mapAssignment(row).agreedTotal,
            clientTotal: mapAssignment(row).agreedTotal,
          },
    };
  }

  /** Completa categoría, cliente y, cuando corresponde, la dirección exacta. */
  private async hydrate(
    supabase: Client,
    rows: readonly JobRow[],
    withExactLocation = false,
  ): Promise<Job[]> {
    if (rows.length === 0) return [];

    const categories = await this.categories.list();
    const categoryById = new Map(categories.map((c) => [c.id, c]));

    const profiles = await loadProfiles(supabase, rows.map((r) => r.client_id));

    let locations = new Map<string, JobPrivateLocationRow>();
    if (withExactLocation) {
      const { data } = await supabase
        .from("job_private_location")
        .select("*")
        .in("job_id", rows.map((r) => r.id))
        .returns<JobPrivateLocationRow[]>();
      locations = new Map((data ?? []).map((l) => [l.job_id, l]));
    }

    return rows
      .map((row) => {
        const category = categoryById.get(row.category_id);
        const client = profiles.get(row.client_id);
        if (!category || !client) return null;
        return mapJob(row, category, client, [], locations.get(row.id) ?? null);
      })
      .filter((j): j is Job => j !== null);
  }
}

/* ------------------------------------------------------------- utilidades */

export async function loadProfiles(supabase: Client, userIds: readonly string[]) {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return new Map<string, ReturnType<typeof mapProfile>>();

  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .in("id", unique)
    .returns<ProfileRow[]>();

  if (error) throw error;
  return new Map((data ?? []).map((p) => [p.id, mapProfile(p)]));
}

export async function loadWorkers(
  supabase: Client,
  userIds: readonly string[],
): Promise<Map<string, WorkerProfile>> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return new Map();

  const [{ data: workers, error: workerError }, profiles, areasResult] = await Promise.all([
    supabase.from("worker_profiles").select(WORKER_COLUMNS).in("user_id", unique)
      .returns<WorkerProfileRow[]>(),
    loadProfiles(supabase, unique),
    supabase.from("worker_service_areas").select("*").in("worker_id", unique)
      .returns<{ id: string; worker_id: string; region_code: string; commune_code: string | null; radius_km: number | null }[]>(),
  ]);

  if (workerError) throw workerError;

  const areasByWorker = new Map<string, WorkerProfile["serviceAreas"]>();
  for (const area of areasResult.data ?? []) {
    const list = [...(areasByWorker.get(area.worker_id) ?? [])];
    list.push({
      id: area.id,
      workerId: area.worker_id,
      regionCode: area.region_code,
      communeCode: area.commune_code,
      radiusKm: area.radius_km,
    });
    areasByWorker.set(area.worker_id, list);
  }

  const result = new Map<string, WorkerProfile>();
  for (const row of workers ?? []) {
    const profile = profiles.get(row.user_id);
    if (profile) {
      result.set(
        row.user_id,
        mapWorkerProfile(row, profile, [], areasByWorker.get(row.user_id) ?? []),
      );
    }
  }
  return result;
}

async function loadAssignmentsByJob(
  supabase: Client,
  jobIds: readonly string[],
): Promise<Map<string, AssignmentRow>> {
  const unique = [...new Set(jobIds)];
  if (unique.length === 0) return new Map();

  const { data, error } = await supabase
    .from("assignments")
    .select(ASSIGNMENT_COLUMNS)
    .in("job_id", unique)
    .returns<AssignmentRow[]>();

  if (error) throw error;
  return new Map((data ?? []).map((a) => [a.job_id, a]));
}

async function loadLatestPayments(
  supabase: Client,
  assignmentIds: readonly string[],
): Promise<Map<string, PaymentRow>> {
  const unique = [...new Set(assignmentIds)].filter(Boolean);
  if (unique.length === 0) return new Map();

  const { data, error } = await supabase
    .from("payments")
    .select(PAYMENT_COLUMNS)
    .in("assignment_id", unique)
    .eq("purpose", "JOB")
    .order("created_at", { ascending: false })
    .returns<PaymentRow[]>();

  if (error) throw error;

  const map = new Map<string, PaymentRow>();
  for (const row of data ?? []) {
    if (row.assignment_id && !map.has(row.assignment_id)) map.set(row.assignment_id, row);
  }
  return map;
}
