import { disputeFileKind } from "@/lib/domain/dispute-evidence";

import { loadProfiles } from "./jobs";
import { type Client } from "./shared";

import type { DisputeRepository } from "../repositories";
import type { UserRole } from "@/lib/domain/enums";
import type { DisputeEvidence } from "@/lib/domain/types";

interface DisputeEvidenceRow {
  id: string;
  dispute_id: string;
  author_id: string | null;
  author_role: string | null;
  body: string | null;
  storage_path: string | null;
  created_at: string;
}

const DISPUTE_EVIDENCE_COLUMNS = "id,dispute_id,author_id,author_role,body,storage_path,created_at";

/**
 * Pruebas de las disputas.
 *
 * Se leen con la sesión de quien consulta: la política `dispute_evidence_read`
 * deja pasar a las dos partes del trabajo y a la administración, y a nadie
 * más. Aquí no se decide quién puede verlas.
 */
export class SupabaseDisputeRepository implements DisputeRepository {
  constructor(private readonly getClient: () => Promise<Client>) {}

  async listEvidence(disputeId: string): Promise<readonly DisputeEvidence[]> {
    const supabase = await this.getClient();
    const { data, error } = await supabase
      .from("dispute_evidence")
      .select(DISPUTE_EVIDENCE_COLUMNS)
      .eq("dispute_id", disputeId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .returns<DisputeEvidenceRow[]>();

    if (error) throw error;
    const rows = data ?? [];

    // El nombre es un adorno: quien no puede leer un perfil (una parte no lee
    // el de la administración) ve el papel en su lugar.
    let names = new Map<string, string>();
    try {
      const profiles = await loadProfiles(
        supabase,
        rows.map((r) => r.author_id ?? ""),
      );
      names = new Map([...profiles].map(([id, p]) => [id, p.displayName]));
    } catch {
      // Sin nombres, la lista sigue siendo útil.
    }

    return rows.map((row) => ({
      id: row.id,
      disputeId: row.dispute_id,
      authorId: row.author_id,
      authorRole: (row.author_role as UserRole | null) ?? null,
      authorName: row.author_id ? (names.get(row.author_id) ?? null) : null,
      body: row.body,
      file: disputeFileKind(row.storage_path),
      createdAt: row.created_at,
    }));
  }
}
