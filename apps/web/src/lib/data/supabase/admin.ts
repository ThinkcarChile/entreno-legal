import { money } from "@/lib/utils/money";
import { publicDisplayName } from "@/lib/utils/format";

import { mapDispute, mapPayout, type DisputeRow, type PayoutRow } from "./mappers";
import { DISPUTE_COLUMNS, PAYOUT_COLUMNS, type Client } from "./shared";
import { loadProfiles } from "./jobs";

import { chunk, fetchAllPages } from "@/lib/utils/pagination";

import {
  CLOSED_DISPUTE_STATUSES,
  CLOSED_PAYOUT_STATUSES,
  confirmedRefundsByDispute,
  pendingDisputeRefund,
  postgrestList,
  type RefundRow,
} from "../admin-queues";

import type {
  AdminDispute,
  AdminPayout,
  AdminQueues,
  AdminRepository,
  Page,
  PendingCheckIn,
  PlatformKpis,
  AdminPayment,
  AdminPaymentFilter,
} from "../repositories";
import type { CheckInResult, PayoutStatus, VerificationStatus } from "@/lib/domain/enums";
import type { VerificationRequest } from "@/lib/domain/types";

interface VerificationRow {
  id: string;
  user_id: string;
  status: string;
  document_type: string | null;
  document_path: string | null;
  selfie_path: string | null;
  rejection_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
}

/**
 * Panel interno.
 *
 * Las lecturas van con la sesión del administrador y quedan sujetas a RLS: si
 * alguien sin el rol abre estas páginas, no ve filas.
 */
export class SupabaseAdminRepository implements AdminRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async getKpis(): Promise<PlatformKpis> {
    const supabase = await this.getClient();
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

  async listVerifications(status?: VerificationStatus): Promise<readonly VerificationRequest[]> {
    const supabase = await this.getClient();

    let query = supabase
      .from("worker_verifications")
      .select("*")
      .order("created_at", { ascending: true });

    if (status) query = query.eq("status", status);

    const { data, error } = await query.returns<VerificationRow[]>();
    if (error) throw error;

    const rows = data ?? [];
    if (rows.length === 0) return [];

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id,first_name,last_name_initial,avatar_url")
      .in("id", rows.map((r) => r.user_id))
      .returns<
        { id: string; first_name: string; last_name_initial: string | null; avatar_url: string | null }[]
      >();

    const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

    return rows.map((row) => {
      const profile = profileById.get(row.user_id);
      return {
        id: row.id,
        userId: row.user_id,
        status: row.status as VerificationStatus,
        displayName: profile
          ? publicDisplayName(profile.first_name, profile.last_name_initial)
          : "Usuario",
        avatarUrl: profile?.avatar_url ?? null,
        documentType: row.document_type,
        documentPath: row.document_path,
        selfiePath: row.selfie_path,
        rejectionReason: row.rejection_reason,
        createdAt: row.created_at,
        reviewedAt: row.reviewed_at,
      };
    });
  }

  /* ------------------------------------------------- colas del Bloque 3 */

  /**
   * Lo que espera una decisión. Lo cuenta la base con `admin_pending_reviews`,
   * que comprueba el rol antes de contestar: si alguien sin permiso abre el
   * panel, no recibe cifras, recibe un error.
   */
  async getQueues(): Promise<AdminQueues> {
    const supabase = await this.getClient();
    const { data, error } = await supabase.rpc("admin_pending_reviews");
    if (error) throw error;
    const row = (data ?? {}) as Record<string, number>;
    return {
      checkIns: Number(row.check_ins ?? 0),
      disputes: Number(row.disputes ?? 0),
      payouts: Number(row.payouts ?? 0),
      refunds: Number(row.refunds ?? 0),
      extensions: Number(row.extensions ?? 0),
    };
  }

  async listPendingCheckIns(): Promise<readonly PendingCheckIn[]> {
    const supabase = await this.getClient();
    // Sin tope, como las demás colas: un trabajo no puede comenzar mientras su
    // llegada espera aquí, así que la que no se ve bloquea a alguien.
    const rows = await fetchAllPages(async (from, to) => {
      const { data, error } = await supabase
        .from("assignment_check_ins")
        .select("id,assignment_id,job_id,worker_id,result,distance_m,review_reason,occurred_at")
        .eq("review_status", "PENDING")
        .order("occurred_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<
          {
            id: string;
            assignment_id: string;
            job_id: string;
            worker_id: string;
            result: string;
            distance_m: number | null;
            review_reason: string | null;
            occurred_at: string;
          }[]
        >();
      if (error) throw error;
      return data ?? [];
    });
    if (rows.length === 0) return [];

    const [jobs, profiles] = await Promise.all([
      selectByIds(
        rows.map((r) => r.job_id),
        (part) =>
          supabase
            .from("jobs")
            .select("id,title,reference")
            .in("id", part)
            .returns<{ id: string; title: string; reference: string }[]>(),
        "trabajos",
      ),
      loadProfilesInChunks(
        supabase,
        rows.map((r) => r.worker_id),
      ),
    ]);

    const jobById = new Map(jobs.map((j) => [j.id, j]));

    return rows.map((row) => ({
      id: row.id,
      assignmentId: row.assignment_id,
      jobId: row.job_id,
      jobTitle: jobById.get(row.job_id)?.title ?? "Trabajo",
      jobReference: jobById.get(row.job_id)?.reference ?? "",
      workerName: profiles.get(row.worker_id)?.displayName ?? "Trabajador",
      result: row.result as CheckInResult,
      distanceM: row.distance_m,
      reviewReason: row.review_reason,
      occurredAt: row.occurred_at,
    }));
  }

  /* ------------------------------------------------ disputas y payouts */

  /*
   * Antes había un `listDisputes` y un `listPayouts` con `.limit(100)`
   * sobre todos los estados, los más recientes primero. Pasados cien registros,
   * un payout aprobado y sin transferir de hace un mes desaparecía de
   * `/admin/payouts`, que es la única pantalla donde se transfiere. Ahora cada
   * pantalla tiene dos listas: lo que pide una acción, entero y del más antiguo
   * al más reciente, y el historial, por páginas. Ver `admin-queues.ts`.
   */

  async listActionableDisputes(): Promise<readonly AdminDispute[]> {
    const supabase = await this.getClient();

    const [open, resolvedWithRefund] = await Promise.all([
      fetchAllPages(async (from, to) => {
        const { data, error } = await supabase
          .from("disputes")
          .select(DISPUTE_COLUMNS)
          .not("status", "in", postgrestList(CLOSED_DISPUTE_STATUSES))
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to)
          .returns<DisputeRow[]>();
        if (error) throw error;
        return data ?? [];
      }),
      // Resueltas con importe a favor del cliente. De estas solo pide una
      // acción la que todavía no se devolvió entera.
      fetchAllPages(async (from, to) => {
        const { data, error } = await supabase
          .from("disputes")
          .select(DISPUTE_COLUMNS)
          .eq("status", "RESOLVED")
          .gt("refund_amount", 0)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to)
          .returns<DisputeRow[]>();
        if (error) throw error;
        return data ?? [];
      }),
    ]);

    const confirmed = await loadConfirmedRefunds(
      supabase,
      resolvedWithRefund.map((r) => r.id),
    );
    const pendingRefund = resolvedWithRefund.filter(
      (r) => pendingDisputeRefund(r.refund_amount, confirmed.get(r.id) ?? 0) > 0,
    );

    const rows = [...open, ...pendingRefund].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    );
    return this.enrichDisputes(supabase, rows, confirmed);
  }

  async listDisputeHistory({
    limit,
    offset,
  }: {
    limit: number;
    offset: number;
  }): Promise<Page<AdminDispute>> {
    const supabase = await this.getClient();
    const { data, error, count } = await supabase
      .from("disputes")
      .select(DISPUTE_COLUMNS, { count: "exact" })
      .in("status", [...CLOSED_DISPUTE_STATUSES])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + limit - 1)
      .returns<DisputeRow[]>();

    if (error) {
      // Una página más allá del final (`?pagina=99`): lista vacía, con el total
      // para poder volver.
      if (isRangeNotSatisfiable(error)) {
        const total = await countWithStatus(supabase, "disputes", CLOSED_DISPUTE_STATUSES);
        return { items: [], total, limit, offset };
      }
      throw error;
    }

    const rows = data ?? [];
    const confirmed = await loadConfirmedRefunds(
      supabase,
      rows.filter((r) => (r.refund_amount ?? 0) > 0).map((r) => r.id),
    );
    return {
      items: await this.enrichDisputes(supabase, rows, confirmed),
      total: count ?? rows.length,
      limit,
      offset,
    };
  }

  private async enrichDisputes(
    supabase: Client,
    rows: readonly DisputeRow[],
    confirmed: ReadonlyMap<string, number>,
  ): Promise<AdminDispute[]> {
    if (rows.length === 0) return [];

    const assignmentIds = rows.map((r) => r.assignment_id);
    const assignments = await selectByIds(
      assignmentIds,
      (part) =>
        supabase
          .from("assignments")
          .select("id,job_id,client_id,worker_id")
          .in("id", part)
          .returns<{ id: string; job_id: string; client_id: string; worker_id: string }[]>(),
      "asignaciones",
    );
    const assignmentById = new Map(assignments.map((a) => [a.id, a]));

    const [jobs, profiles, payouts] = await Promise.all([
      selectByIds(
        assignments.map((a) => a.job_id),
        (part) =>
          supabase
            .from("jobs")
            .select("id,title,reference")
            .in("id", part)
            .returns<{ id: string; title: string; reference: string }[]>(),
        "trabajos",
      ),
      loadProfilesInChunks(
        supabase,
        assignments.flatMap((a) => [a.client_id, a.worker_id]),
      ),
      selectByIds(
        assignmentIds,
        (part) =>
          supabase
            .from("payouts")
            .select("assignment_id,status,net_amount")
            .in("assignment_id", part)
            .returns<{ assignment_id: string; status: string; net_amount: number }[]>(),
        "payouts",
      ),
    ]);

    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const payoutByAssignment = new Map(payouts.map((p) => [p.assignment_id, p]));

    return rows.map((row) => {
      const assignment = assignmentById.get(row.assignment_id);
      const job = assignment ? jobById.get(assignment.job_id) : undefined;
      const payout = payoutByAssignment.get(row.assignment_id);
      const pending = pendingDisputeRefund(row.refund_amount, confirmed.get(row.id) ?? 0);
      return {
        dispute: mapDispute(row),
        jobId: assignment?.job_id ?? "",
        jobTitle: job?.title ?? "Trabajo",
        jobReference: job?.reference ?? "",
        clientName: assignment ? (profiles.get(assignment.client_id)?.displayName ?? "Cliente") : "",
        workerName: assignment
          ? (profiles.get(assignment.worker_id)?.displayName ?? "Trabajador")
          : "",
        amountHeld: payout ? money(payout.net_amount) : null,
        payoutStatus: (payout?.status as PayoutStatus | undefined) ?? null,
        refundPending: pending > 0 ? money(pending) : null,
      };
    });
  }

  async listActionablePayouts(): Promise<readonly AdminPayout[]> {
    const supabase = await this.getClient();
    const rows = await fetchAllPages(async (from, to) => {
      const { data, error } = await supabase
        .from("payouts")
        .select(PAYOUT_COLUMNS)
        .not("status", "in", postgrestList(CLOSED_PAYOUT_STATUSES))
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<PayoutRow[]>();
      if (error) throw error;
      return data ?? [];
    });
    return this.enrichPayouts(supabase, rows);
  }

  async listPayoutHistory({
    limit,
    offset,
  }: {
    limit: number;
    offset: number;
  }): Promise<Page<AdminPayout>> {
    const supabase = await this.getClient();
    const { data, error, count } = await supabase
      .from("payouts")
      .select(PAYOUT_COLUMNS, { count: "exact" })
      .in("status", [...CLOSED_PAYOUT_STATUSES])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + limit - 1)
      .returns<PayoutRow[]>();

    if (error) {
      if (isRangeNotSatisfiable(error)) {
        const total = await countWithStatus(supabase, "payouts", CLOSED_PAYOUT_STATUSES);
        return { items: [], total, limit, offset };
      }
      throw error;
    }

    const rows = data ?? [];
    return {
      items: await this.enrichPayouts(supabase, rows),
      total: count ?? rows.length,
      limit,
      offset,
    };
  }

  private async enrichPayouts(supabase: Client, rows: readonly PayoutRow[]): Promise<AdminPayout[]> {
    if (rows.length === 0) return [];

    const assignments = await selectByIds(
      rows.map((r) => r.assignment_id),
      (part) =>
        supabase
          .from("assignments")
          .select("id,job_id,completed_at,dispute_deadline_at")
          .in("id", part)
          .returns<
            {
              id: string;
              job_id: string;
              completed_at: string | null;
              dispute_deadline_at: string | null;
            }[]
          >(),
      "asignaciones",
    );
    const assignmentById = new Map(assignments.map((a) => [a.id, a]));

    const [jobs, profiles] = await Promise.all([
      selectByIds(
        assignments.map((a) => a.job_id),
        (part) =>
          supabase
            .from("jobs")
            .select("id,title,reference")
            .in("id", part)
            .returns<{ id: string; title: string; reference: string }[]>(),
        "trabajos",
      ),
      loadProfilesInChunks(
        supabase,
        rows.map((r) => r.worker_id),
      ),
    ]);

    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const readAt = Date.now();

    return rows.map((row) => {
      const assignment = assignmentById.get(row.assignment_id);
      const job = assignment ? jobById.get(assignment.job_id) : undefined;
      return {
        payout: mapPayout(row),
        jobTitle: job?.title ?? "Trabajo",
        jobReference: job?.reference ?? "",
        workerName: profiles.get(row.worker_id)?.displayName ?? "Trabajador",
        completedAt: assignment?.completed_at ?? null,
        disputeDeadlineAt: assignment?.dispute_deadline_at ?? null,
        disputeWindowOpen: assignment?.dispute_deadline_at
          ? new Date(assignment.dispute_deadline_at).getTime() > readAt
          : false,
      };
    });
  }

  /**
   * Pagos del cliente hacia la plataforma.
   *
   * Sale de la vista `admin_payments`, que NO expone `provider_token`: el token
   * autoriza confirmar y devolver, así que no viaja a ninguna pantalla. Las
   * operaciones que lo necesitan lo leen en el servidor, con la clave de
   * servicio.
   */
  async listPayments(filter: AdminPaymentFilter = "all"): Promise<readonly AdminPayment[]> {
    const supabase = await this.getClient();
    let query = supabase
      .from("admin_payments")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (filter === "review") query = query.eq("status", "UNDER_REVIEW");
    if (filter === "pending") query = query.in("status", ["PENDING", "CREATED", "AUTHORIZED"]);
    if (filter === "refunded") query = query.in("status", ["REFUNDED", "PARTIALLY_REFUNDED"]);

    const { data, error } = await query.returns<Record<string, unknown>[]>();
    if (error) throw error;

    return (data ?? []).map((row) => ({
      paymentId: String(row.payment_id),
      jobId: String(row.job_id),
      assignmentId: (row.assignment_id as string | null) ?? null,
      jobReference: String(row.job_reference ?? ""),
      jobTitle: String(row.job_title ?? ""),
      clientId: String(row.client_id),
      purpose: String(row.purpose),
      status: String(row.status),
      provider: String(row.provider),
      environment: (row.environment as string | null) ?? null,
      buyOrder: (row.buy_order as string | null) ?? null,
      amount: Number(row.amount ?? 0),
      refundedAmount: Number(row.refunded_amount ?? 0),
      refundableAmount: Number(row.refundable_amount ?? 0),
      providerStatus: (row.provider_status as string | null) ?? null,
      responseCode: row.response_code == null ? null : Number(row.response_code),
      authorizationCode: (row.authorization_code as string | null) ?? null,
      cardLastDigits: (row.card_last_digits as string | null) ?? null,
      paymentTypeCode: (row.payment_type_code as string | null) ?? null,
      installments: row.installments == null ? null : Number(row.installments),
      vci: (row.vci as string | null) ?? null,
      attempt: Number(row.attempt ?? 0),
      failureReason: (row.failure_reason as string | null) ?? null,
      reviewReason: (row.review_reason as string | null) ?? null,
      createdAt: String(row.created_at),
      paidAt: (row.paid_at as string | null) ?? null,
      capturedAt: (row.captured_at as string | null) ?? null,
      committedAt: (row.committed_at as string | null) ?? null,
      reconciledAt: (row.reconciled_at as string | null) ?? null,
      eventCount: Number(row.event_count ?? 0),
      refundCount: Number(row.refund_count ?? 0),
      disputeId: (row.dispute_id as string | null) ?? null,
      payoutId: (row.payout_id as string | null) ?? null,
    }));
  }

}

/* ---------------------------------------------------------------- piezas */

/** Identificadores por consulta `.in()`: cien uuid ya son 3,7 KB de URL. */
const IN_CHUNK = 100;

interface ChunkResult<T> {
  data: T[] | null;
  error: { message: string; code?: string } | null;
}

/**
 * Una consulta `.in("id", …)` partida en trozos.
 *
 * Las listas sin tope pueden traer cientos de filas, y un `in.(…)` con todos
 * sus identificadores no cabe en la URL de una petición a PostgREST. Un trozo
 * que falla se registra y se omite: la fila principal se sigue mostrando, con
 * «Trabajo» o «Trabajador» en vez del nombre, como antes.
 */
async function selectByIds<T>(
  ids: readonly string[],
  query: (part: string[]) => PromiseLike<ChunkResult<T>>,
  what: string,
): Promise<T[]> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return [];
  const results = await Promise.all(chunk(unique, IN_CHUNK).map((part) => query(part)));
  const rows: T[] = [];
  for (const { data, error } of results) {
    if (error) {
      console.error(`[admin] no se pudieron leer ${what}`, { code: error.code ?? null });
      continue;
    }
    rows.push(...(data ?? []));
  }
  return rows;
}

/** `loadProfiles` por trozos, por la misma razón. */
async function loadProfilesInChunks(supabase: Client, ids: readonly string[]) {
  const unique = [...new Set(ids)].filter(Boolean);
  const maps = await Promise.all(chunk(unique, IN_CHUNK).map((part) => loadProfiles(supabase, part)));
  return new Map(maps.flatMap((m) => [...m]));
}

/**
 * Lo devuelto de verdad por cada disputa, desde `payment_refunds` (solo la lee
 * administración).
 *
 * Si la lectura falla, se asume que no se devolvió nada: la disputa sigue en
 * la lista de pendientes. Equivocarse hacia «pendiente» deja una tarjeta de
 * más; equivocarse hacia «devuelto» escondería una devolución que se debe.
 */
async function loadConfirmedRefunds(
  supabase: Client,
  disputeIds: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(disputeIds)].filter(Boolean);
  if (unique.length === 0) return new Map();
  try {
    const rows = await selectStrict<RefundRow>(unique, (part) =>
      supabase
        .from("payment_refunds")
        .select("dispute_id,amount,status")
        .in("dispute_id", part)
        .eq("status", "CONFIRMED")
        .returns<RefundRow[]>(),
    );
    return confirmedRefundsByDispute(rows);
  } catch (error) {
    console.error("[admin] no se pudieron leer las devoluciones; se muestran como pendientes", {
      code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
    });
    return new Map();
  }
}

/** Como `selectByIds`, pero un trozo que falla hace fallar todo. */
async function selectStrict<T>(
  ids: readonly string[],
  query: (part: string[]) => PromiseLike<ChunkResult<T>>,
): Promise<T[]> {
  const results = await Promise.all(chunk([...ids], IN_CHUNK).map((part) => query(part)));
  return results.flatMap(({ data, error }) => {
    if (error) throw error;
    return data ?? [];
  });
}

/** PostgREST responde 416 (PGRST103) a una página que empieza después de la última fila. */
function isRangeNotSatisfiable(error: { code?: string }): boolean {
  return error.code === "PGRST103";
}

async function countWithStatus(
  supabase: Client,
  table: "disputes" | "payouts",
  statuses: readonly string[],
): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .in("status", [...statuses]);
  if (error) throw error;
  return count ?? 0;
}
