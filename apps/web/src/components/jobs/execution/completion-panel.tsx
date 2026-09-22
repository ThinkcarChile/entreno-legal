"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { CheckCircle2, ShieldAlert } from "lucide-react";

import { Amount, Button, Field, Textarea } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { approveCompletionAction } from "@/lib/actions/assignment";
import { openDisputeAction } from "@/lib/actions/disputes";
import type { Money } from "@/lib/utils/money";

/**
 * Aprobación del trabajo por el cliente.
 *
 * Es la acción que libera el pago al trabajador, y por eso está separada del
 * botón «terminé» del trabajador. Antes de aprobar, el cliente tiene delante lo
 * que va a aprobar: el tiempo, la evidencia y el importe.
 */
export function ApprovalPanel({
  assignmentId,
  bonus,
  bonusConditions,
  workerReceives,
}: {
  assignmentId: string;
  bonus: Money | null;
  bonusConditions: string | null;
  workerReceives: Money;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [bonusAwarded, setBonusAwarded] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function approve() {
    setError(null);
    startTransition(async () => {
      const result = await approveCompletionAction(assignmentId, bonusAwarded);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  if (!confirming) {
    return (
      <Button size="lg" fullWidth onClick={() => setConfirming(true)}>
        <CheckCircle2 size={16} aria-hidden="true" />
        Aprobar el trabajo
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-control)] border border-line p-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="text-small text-ink-800">
        Al aprobar, el pago de <Amount value={workerReceives} /> queda liberado para el
        trabajador. Después de esto ya no se puede deshacer desde aquí.
      </p>

      {bonus && (
        <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] bg-success-50 p-3 text-small">
          <input
            type="checkbox"
            checked={bonusAwarded}
            onChange={(event) => setBonusAwarded(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-success-600"
          />
          <span className="text-success-800">
            Se cumplió el objetivo del bono (<Amount value={bonus} />).
            {bonusConditions && <span className="block text-success-700">{bonusConditions}</span>}
          </span>
        </label>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={approve} disabled={pending}>
          {pending ? "Aprobando…" : "Sí, aprobar y liberar el pago"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={pending}>
          Volver
        </Button>
      </div>
    </div>
  );
}

const REASONS = [
  "El trabajo no se realizó",
  "Llegó tarde",
  "Problema con la entrega",
  "El resultado no fue el acordado",
  "Otro",
] as const;

/** Reportar un problema. Retiene el pago y lo revisa la administración. */
export function DisputeForm({ assignmentId }: { assignmentId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await openDisputeAction(assignmentId, reason, description);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" fullWidth onClick={() => setOpen(true)}>
        <ShieldAlert size={15} aria-hidden="true" />
        Reportar un problema
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-control)] border border-danger-100 bg-danger-50/50 p-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="text-small text-ink-800">
        El pago al trabajador queda retenido mientras se revisa. Te pediremos evidencia a las dos
        partes.
      </p>

      <fieldset className="space-y-1.5">
        <legend className="text-small font-medium text-ink-800">¿Qué ocurrió?</legend>
        {REASONS.map((option) => (
          <label key={option} className="flex items-center gap-2 text-small text-ink-700">
            <input
              type="radio"
              name="dispute-reason"
              value={option}
              checked={reason === option}
              onChange={() => setReason(option)}
              className="h-4 w-4 accent-brand-600"
            />
            {option}
          </label>
        ))}
      </fieldset>

      <Field label="Cuéntanos qué pasó" htmlFor="dispute-description" required hint="Mínimo 20 caracteres.">
        <Textarea
          id="dispute-description"
          rows={3}
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>

      <div className="flex gap-2">
        <Button variant="danger" size="sm" onClick={submit} disabled={pending}>
          {pending ? "Enviando…" : "Enviar reporte"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Volver
        </Button>
      </div>
    </div>
  );
}
