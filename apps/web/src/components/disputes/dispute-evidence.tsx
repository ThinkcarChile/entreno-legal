import { Scale } from "lucide-react";

import { Card, CardContent } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { getData } from "@/lib/data";
import { disputeEvidenceCountLabel } from "@/lib/domain/dispute-evidence";
import type { Dispute, DisputeEvidence as DisputeEvidenceItem } from "@/lib/domain/types";

import { DisputeEvidenceForm } from "./dispute-evidence-form";
import { DisputeEvidenceList } from "./dispute-evidence-list";

/**
 * Pruebas de una disputa: la lista y, mientras la disputa las acepte, el
 * formulario para aportar otra.
 *
 * Es la misma pieza para el cliente, el trabajador y la administración, y lee
 * sus propios datos para que insertarla en una página sea una línea. Quién
 * puede verlas lo decide RLS; quién puede aportar, `add_dispute_evidence` en
 * la base (las partes y la administración, mientras la disputa no esté
 * resuelta). `canAdd` solo decide si se muestra el formulario.
 */
export async function DisputeEvidence({
  assignmentId,
  dispute,
  canAdd,
  timezone,
}: {
  assignmentId: string;
  dispute: Pick<Dispute, "id">;
  canAdd: boolean;
  timezone?: string;
}) {
  let items: readonly DisputeEvidenceItem[] | null = null;
  try {
    items = await getData().disputes.listEvidence(dispute.id);
  } catch (error) {
    console.error("[disputas] no se pudieron leer las pruebas", {
      code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
    });
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink-950">
            <Scale size={17} className="text-ink-400" aria-hidden="true" />
            Pruebas de la disputa
          </h2>
          <p className="mt-1 text-small text-ink-500">
            {items ? disputeEvidenceCountLabel(items.length) : disputeEvidenceCountLabel(null)}.
            Las ven las dos partes y el equipo que resuelve el caso.
          </p>
        </div>

        {items ? (
          <DisputeEvidenceList items={items} timezone={timezone} />
        ) : (
          <Alert tone="warning">No pudimos cargar las pruebas. Recarga la página.</Alert>
        )}

        {canAdd && <DisputeEvidenceForm assignmentId={assignmentId} disputeId={dispute.id} />}
      </CardContent>
    </Card>
  );
}
