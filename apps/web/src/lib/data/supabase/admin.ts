import { avatarPublicUrl } from "@/lib/storage/avatars";
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
  disputePaymentId,
  disputeRefundTarget,
  orderByIds,
  pendingDisputeRefund,
  postgrestList,
  REFUNDED_PAYMENT_STATUSES,
  UNRESOLVED_PAYMENT_STATUSES,
  type ActionablePaymentFilter,
  type DisputeShareRow,
  type JobPaymentRow,
  type PaymentHistoryFilter,
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
  AdminReviewAttempt,
  IntegrityAlert,
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
        avatarUrl: avatarPublicUrl(profile?.avatar_url),
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

    // Por instante, no por texto: `localeCompare` ordena «.» antes que «+», y
    // PostgreSQL omite los decimales en cero, así que dentro de un mismo
    // segundo el texto no sigue al reloj. El desempate por `id` es el de la base.
    const rows = [...open, ...pendingRefund].sort(
      (a, b) =>
        Date.parse(a.created_at) - Date.parse(b.created_at) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
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

    const [jobs, profiles, payouts, jobPayments, shares] = await Promise.all([
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
      // El pago del trabajo de cada asignación: a él lleva «Devolución
      // pendiente». Si la lectura falla, el enlace cae en la cola «En revisión».
      selectByIds(
        assignmentIds,
        (part) =>
          supabase
            .from("payments")
            .select("id,assignment_id,status,created_at")
            .in("assignment_id", part)
            .eq("purpose", "JOB")
            .returns<(JobPaymentRow & { assignment_id: string })[]>(),
        "pagos",
      ),
      // La parte de cada disputa sobre cada cobro, de la cola: el enlace va al
      // primero que todavía tiene algo por pedir, que puede ser el del tiempo
      // adicional. Si la lectura falla, cae en el pago del trabajo.
      selectByIds(
        rows.filter((r) => r.status === "RESOLVED" && (r.refund_amount ?? 0) > 0).map((r) => r.id),
        async (part) => {
          const { data, error } = await supabase
            .rpc("admin_payment_review_queue")
            .select("payment_id,created_at,dispute_id,dispute_refund_pending")
            .in("dispute_id", part)
            .gt("dispute_refund_pending", 0);
          return { data: asRows<DisputeShareRow & { dispute_id: string }>(data), error };
        },
        "devoluciones de disputas",
      ),
    ]);

    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const payoutByAssignment = new Map(payouts.map((p) => [p.assignment_id, p]));
    const paymentsByAssignment = new Map<string, JobPaymentRow[]>();
    for (const payment of jobPayments) {
      const list = paymentsByAssignment.get(payment.assignment_id) ?? [];
      list.push(payment);
      paymentsByAssignment.set(payment.assignment_id, list);
    }
    const sharesByDispute = new Map<string, DisputeShareRow[]>();
    for (const share of shares) {
      const list = sharesByDispute.get(share.dispute_id) ?? [];
      list.push(share);
      sharesByDispute.set(share.dispute_id, list);
    }

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
        paymentId:
          disputeRefundTarget(
            sharesByDispute.get(row.id) ?? [],
            new Set((paymentsByAssignment.get(row.assignment_id) ?? []).map((p) => p.id)),
          ) ?? disputePaymentId(paymentsByAssignment.get(row.assignment_id) ?? []),
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

  /*
   * Pagos del cliente hacia la plataforma.
   *
   * Salen de la vista `admin_payments`, que NO expone `provider_token`: el token
   * autoriza confirmar y devolver, así que no viaja a ninguna pantalla. Las
   * operaciones que lo necesitan lo leen en el servidor, con la clave de
   * servicio.
   *
   * Antes era un solo `listPayments` con `.limit(100)` y los más recientes
   * primero, también para «En revisión»: pasados cien pagos, uno en revisión
   * o con una devolución por confirmar de hace meses no salía en ningún
   * filtro, y la tarjeta del panel lo seguía contando. Ahora es la misma regla
   * que payouts y disputas: lo que pide una acción, entero y del más antiguo
   * al más reciente; el resto, por páginas. Ver `admin-queues.ts`.
   */

  async listActionablePayments(filter: ActionablePaymentFilter): Promise<readonly AdminPayment[]> {
    const supabase = await this.getClient();

    if (filter === "review") {
      // La cola la define la base, una sola vez (`admin_payment_review_queue`,
      // migración 20260601001510), y es la misma que cuenta
      // `admin_pending_reviews`: la cifra de «Devoluciones por procesar» es el
      // largo de esta lista. Un pago por fila: en revisión, con una devolución
      // sin resultado final, con un intento duplicado por devolver o con la
      // devolución de una disputa resuelta todavía sin pedir.
      const queue = await fetchAllPages(async (from, to) => {
        const { data, error } = await supabase
          .rpc("admin_payment_review_queue")
          .order("created_at", { ascending: true })
          .order("payment_id", { ascending: true })
          .range(from, to);
        if (error) throw error;
        return asRows<ReviewQueueRow>(data);
      });
      const ids = queue.map((q) => q.payment_id);
      const rows = await selectStrict<PaymentRow>(ids, (part) =>
        supabase
          .from("admin_payments")
          .select("*")
          .in("payment_id", part)
          .returns<PaymentRow[]>(),
      );
      const shareById = new Map(queue.map((q) => [q.payment_id, disputeShareOf(q)]));
      return orderByIds(rows, ids, (row) => String(row.payment_id)).map((row) =>
        mapAdminPayment(row, shareById.get(String(row.payment_id)) ?? NO_DISPUTE_SHARE),
      );
    }

    const rows = await fetchAllPages(async (from, to) => {
      const { data, error } = await supabase
        .from("admin_payments")
        .select("*")
        .in("status", [...UNRESOLVED_PAYMENT_STATUSES])
        .order("created_at", { ascending: true })
        .order("payment_id", { ascending: true })
        .range(from, to)
        .returns<PaymentRow[]>();
      if (error) throw error;
      return data ?? [];
    });
    return this.withDisputeRefunds(supabase, rows);
  }

  async listPaymentHistory(
    filter: PaymentHistoryFilter,
    { limit, offset }: { limit: number; offset: number },
  ): Promise<Page<AdminPayment>> {
    const supabase = await this.getClient();
    let query = supabase
      .from("admin_payments")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .order("payment_id", { ascending: false })
      .range(offset, offset + limit - 1);
    if (filter === "refunded") query = query.in("status", [...REFUNDED_PAYMENT_STATUSES]);

    const { data, error, count } = await query.returns<PaymentRow[]>();
    if (error) {
      if (isRangeNotSatisfiable(error)) {
        const total = await countPayments(supabase, filter);
        return { items: [], total, limit, offset };
      }
      throw error;
    }

    const rows = data ?? [];
    return {
      items: await this.withDisputeRefunds(supabase, rows),
      total: count ?? rows.length,
      limit,
      offset,
    };
  }

  /** Un pago por su id: a él lleva «Devolución pendiente» en `/admin/disputas`. */
  async getPayment(paymentId: string): Promise<AdminPayment | null> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("admin_payments")
      .select("*")
      .eq("payment_id", paymentId)
      .maybeSingle<PaymentRow>();
    if (error) throw error;
    if (!data) return null;
    const [payment] = await this.withDisputeRefunds(supabase, [data]);
    return payment ?? null;
  }

  /**
   * Lo que falta pedir por una disputa sobre cada cobro, y la disputa a la que
   * se liga, para los pagos de una lista que no salió de la cola. Si la
   * lectura falla, el pago se muestra igual, sin ese aviso y sin ligar ninguna
   * devolución a una disputa: la cola «En revisión» lo sigue teniendo.
   */
  private async withDisputeRefunds(
    supabase: Client,
    rows: readonly PaymentRow[],
  ): Promise<AdminPayment[]> {
    if (rows.length === 0) return [];
    const queue = await selectByIds(
      rows.map((row) => String(row.payment_id)),
      async (part) => {
        const { data, error } = await supabase
          .rpc("admin_payment_review_queue")
          .select("payment_id,dispute_id,dispute_refund_pending")
          .in("payment_id", part)
          .gt("dispute_refund_pending", 0);
        return {
          data: asRows<Pick<ReviewQueueRow, "payment_id" | "dispute_id" | "dispute_refund_pending">>(data),
          error,
        };
      },
      "devoluciones de disputas",
    );
    const shareById = new Map(queue.map((q) => [q.payment_id, disputeShareOf(q)]));
    return rows.map((row) =>
      mapAdminPayment(row, shareById.get(String(row.payment_id)) ?? NO_DISPUTE_SHARE),
    );
  }

  /**
   * Reglas de invariante rotas según la última pasada de las tareas
   * programadas. `admin_integrity_alerts` comprueba el rol: sin él, error.
   */
  async listIntegrityAlerts(): Promise<readonly IntegrityAlert[]> {
    const supabase = await this.getClient();
    const { data, error } = await supabase.rpc("admin_integrity_alerts");
    if (error) throw error;
    return asRows<IntegrityAlertRow>(data).map((row) => ({
      alertId: row.alert_id,
      source: row.source,
      kind: row.kind,
      violationCount: Number(row.violation_count ?? 0),
      sampleIds: row.sample_ids ?? [],
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      lastNotifiedAt: row.last_notified_at,
      acknowledgedAt: row.acknowledged_at,
      unacknowledged: Boolean(row.unacknowledged),
    }));
  }
}

/* ------------------------------------------------------------ pagos */

type PaymentRow = Record<string, unknown>;

/** Una fila de `admin_payment_review_queue`. */
interface ReviewQueueRow {
  payment_id: string;
  created_at: string;
  under_review: boolean;
  open_refund: boolean;
  attempts_in_review: number;
  dispute_id: string | null;
  dispute_refund_pending: number;
}

interface IntegrityAlertRow {
  alert_id: string;
  source: string;
  kind: string;
  violation_count: number;
  sample_ids: string[] | null;
  first_seen_at: string;
  last_seen_at: string;
  last_notified_at: string | null;
  acknowledged_at: string | null;
  unacknowledged: boolean;
}

/**
 * Las filas de una función que devuelve una tabla. El cliente no tiene los
 * tipos generados de la base, así que la forma la fija quien llama, como
 * `.returns<T>()` en las consultas a tablas y vistas.
 */
function asRows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

/** La parte de una disputa sobre un cobro, según la cola. */
interface DisputeShare {
  pending: number;
  disputeId: string | null;
}

const NO_DISPUTE_SHARE: DisputeShare = { pending: 0, disputeId: null };

function disputeShareOf(row: Pick<ReviewQueueRow, "dispute_id" | "dispute_refund_pending">): DisputeShare {
  const pending = Number(row.dispute_refund_pending ?? 0);
  return { pending, disputeId: pending > 0 ? (row.dispute_id ?? null) : null };
}

function mapAdminPayment(row: PaymentRow, disputeShare: DisputeShare): AdminPayment {
  return {
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
    attemptsInReview: Number(row.attempts_in_review ?? 0),
    attemptsReviewDetail: (row.attempts_review_detail as string | null) ?? null,
    openRefund: row.open_refund_id
      ? {
          refundId: String(row.open_refund_id),
          status: row.open_refund_status === "UNKNOWN" ? "UNKNOWN" : "REQUESTED",
          amount: Number(row.open_refund_amount ?? 0),
          requestedAt: String(row.open_refund_requested_at),
          unknownReason: (row.open_refund_unknown_reason as string | null) ?? null,
          lastCheckedAt: (row.open_refund_last_checked_at as string | null) ?? null,
          lastCheckResult: (row.open_refund_last_check_result as string | null) ?? null,
        }
      : null,
    reviewAttempts: reviewAttemptsOf(row.attempts_review),
    disputeRefundPending: disputeShare.pending,
    disputeRefundId: disputeShare.disputeId,
  };
}

/* ---------------------------------------------------------------- piezas */

const ATTEMPT_REFUND_STATUSES = ["REQUESTED", "UNKNOWN", "CONFIRMED", "FAILED", "CANCELLED"] as const;

/** `admin_payments.attempts_review`: los intentos en revisión y su devolución. */
function reviewAttemptsOf(value: unknown): AdminReviewAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const a = item as Record<string, unknown>;
    const r = (a.refund ?? null) as Record<string, unknown> | null;
    const status = ATTEMPT_REFUND_STATUSES.find((s) => s === r?.status) ?? "REQUESTED";
    return {
      attemptId: String(a.attempt_id),
      attempt: Number(a.attempt ?? 0),
      buyOrder: String(a.buy_order ?? ""),
      status: String(a.status ?? ""),
      reviewReason: (a.review_reason as string | null) ?? null,
      amount: Number(a.amount ?? 0),
      backsPayment: a.backs_payment === true,
      refund: r
        ? {
            refundId: String(r.refund_id),
            status,
            kind: (r.kind as string | null) ?? null,
            amount: Number(r.amount ?? 0),
            requestedAt: String(r.requested_at),
            settledAt: (r.settled_at as string | null) ?? null,
            failureReason: (r.failure_reason as string | null) ?? null,
            unknownReason: (r.unknown_reason as string | null) ?? null,
            lastCheckedAt: (r.last_checked_at as string | null) ?? null,
            lastCheckResult: (r.last_check_result as string | null) ?? null,
          }
        : null,
    };
  });
}

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

/** Cuántos pagos hay en un filtro del historial («Todos» o «Devueltos»). */
async function countPayments(supabase: Client, filter: PaymentHistoryFilter): Promise<number> {
  let query = supabase.from("admin_payments").select("payment_id", { count: "exact", head: true });
  if (filter === "refunded") query = query.in("status", [...REFUNDED_PAYMENT_STATUSES]);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}
