import { money } from "@/lib/utils/money";
import { publicDisplayName } from "@/lib/utils/format";

import { type Client } from "./shared";

import type { AdminRepository, PlatformKpis } from "../repositories";
import type { VerificationStatus } from "@/lib/domain/enums";
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
}
