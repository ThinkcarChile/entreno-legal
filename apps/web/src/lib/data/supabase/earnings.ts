import { money } from "@/lib/utils/money";

import { mapEarning, type EarningRow } from "./mappers";
import { currentUserId, type Client } from "./shared";

import type { EarningsRepository } from "../repositories";
import type { Earning, EarningsSummary } from "@/lib/domain/types";

/**
 * Ganancias del trabajador.
 *
 * Lee la vista `worker_earnings`, que es `security_invoker`: la RLS de
 * `payouts` decide qué filas devuelve, así que nadie ve las de otro aunque
 * la consulta no filtre por identificador.
 *
 * Ninguna cifra de aquí afirma que haya habido una transferencia: el estado
 * PAID solo existe cuando la administración registró una referencia bancaria.
 */
export class SupabaseEarningsRepository implements EarningsRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async listMine(): Promise<readonly Earning[]> {
    const supabase = await this.getClient();
    const userId = await currentUserId(supabase);
    if (!userId) return [];

    const { data, error } = await supabase
      .from("worker_earnings")
      .select("*")
      .eq("worker_id", userId)
      .order("created_at", { ascending: false })
      .limit(200)
      .returns<EarningRow[]>();

    if (error) throw error;
    return (data ?? []).map(mapEarning);
  }

  async summary(): Promise<EarningsSummary> {
    const rows = await this.listMine();
    const total = (status: string): number =>
      rows.filter((r) => r.status === status).reduce((sum, r) => sum + r.netAmount.amount, 0);

    return {
      pending: money(total("PENDING")),
      approved: money(total("APPROVED") + total("PROCESSING")),
      held: money(total("HELD")),
      paid: money(total("PAID")),
      cancelled: money(total("CANCELLED")),
    };
  }
}
