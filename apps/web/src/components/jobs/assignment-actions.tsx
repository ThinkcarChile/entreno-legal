"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { ArrowRight } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { Button } from "@/components/ui";
import { advanceAssignmentAction } from "@/lib/actions/assignment";
import { AssignmentStatus } from "@/lib/domain/enums";
import { nextWorkerStep } from "@/lib/domain/job-actions";

/**
 * Avance del trabajo por parte del trabajador.
 *
 * Solo aparece el paso que corresponde ahora. No se muestran botones imposibles:
 * la máquina de estados decide, y la base vuelve a validarlo.
 */
export function AssignmentActions({
  assignmentId,
  status,
}: {
  assignmentId: string;
  status: AssignmentStatus;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const step = nextWorkerStep(status);

  if (!step) {
    if (status === AssignmentStatus.AWAITING_PAYMENT) {
      return (
        <Alert tone="warning" title="Esperando el pago del cliente">
          El trabajo no puede comenzar hasta que el pago esté confirmado. Te avisamos apenas
          ocurra.
        </Alert>
      );
    }
    return null;
  }

  function advance() {
    setError(null);
    startTransition(async () => {
      const result = await advanceAssignmentAction(assignmentId, step!.to);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}
      <Button size="lg" fullWidth onClick={advance} disabled={pending}>
        {pending ? "Registrando…" : step.label}
        <ArrowRight size={16} aria-hidden="true" />
      </Button>
      <p className="text-xs text-ink-500">{step.description}</p>
    </div>
  );
}
