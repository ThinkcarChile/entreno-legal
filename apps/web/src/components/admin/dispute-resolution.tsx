"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button, Field, Input, Textarea } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { resolveDisputeAction } from "@/lib/actions/admin";
import { DisputeResolution } from "@/lib/domain/enums";

/**
 * Resolución de una disputa.
 *
 * Define quién se queda con qué dentro de la plataforma. **No ejecuta ninguna
 * devolución bancaria**: el importe a favor del cliente queda anotado para
 * procesarse cuando exista la integración con el medio de pago. La pantalla lo
 * dice con esas palabras, porque la alternativa es que alguien crea que el
 * dinero ya salió.
 */
const OPTIONS = [
  {
    value: DisputeResolution.WORKER_WINS,
    label: "A favor del trabajador",
    hint: "Se libera el pago completo.",
  },
  {
    value: DisputeResolution.CLIENT_WINS,
    label: "A favor del cliente",
    hint: "Se cancela el pago al trabajador.",
  },
  {
    value: DisputeResolution.PARTIAL,
    label: "Resolución parcial",
    hint: "Se descuenta del pago al trabajador el monto que corresponde al cliente.",
  },
] as const;

export function DisputeResolutionForm({ disputeId }: { disputeId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState<string>(DisputeResolution.WORKER_WINS);
  const [notes, setNotes] = useState("");
  const [refund, setRefund] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    if (!confirmed) {
      setError("Confirma que revisaste la evidencia y las declaraciones de ambas partes.");
      return;
    }
    startTransition(async () => {
      const result = await resolveDisputeAction(
        disputeId,
        resolution as "WORKER_WINS" | "CLIENT_WINS" | "PARTIAL",
        notes,
        resolution === DisputeResolution.PARTIAL ? Number(refund) : null,
      );
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
      <Button size="sm" onClick={() => setOpen(true)}>
        Resolver
      </Button>
    );
  }

  return (
    <div className="w-full space-y-3 rounded-[var(--radius-control)] border border-line bg-surface p-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <fieldset className="space-y-2">
        <legend className="text-small font-medium text-ink-800">Resultado de la disputa</legend>
        {OPTIONS.map((option) => (
          <label key={option.value} className="flex items-start gap-2 text-small">
            <input
              type="radio"
              name={`resolution-${disputeId}`}
              value={option.value}
              checked={resolution === option.value}
              onChange={() => setResolution(option.value)}
              className="mt-1 h-4 w-4 accent-brand-600"
            />
            <span>
              <span className="font-medium text-ink-950">{option.label}</span>
              <span className="block text-ink-500">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {resolution === DisputeResolution.PARTIAL && (
        <Field label="Monto a devolver al cliente (CLP)" htmlFor={`refund-${disputeId}`} required>
          <Input
            id={`refund-${disputeId}`}
            type="number"
            min={1}
            step={1}
            value={refund}
            onChange={(event) => setRefund(event.target.value)}
          />
        </Field>
      )}

      <Field label="Motivo de la resolución" htmlFor={`notes-${disputeId}`} required>
        <Textarea
          id={`notes-${disputeId}`}
          rows={3}
          maxLength={1000}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Lo leen las dos partes."
        />
      </Field>

      <Alert tone="warning">
        No se ejecuta ningún reembolso bancario automático. Esta decisión define la liberación de
        fondos dentro de la plataforma y deja anotado el monto a devolver.
      </Alert>

      <label className="flex items-start gap-2 text-small text-ink-700">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-brand-600"
        />
        Confirmo que revisé la evidencia y las declaraciones de ambas partes.
      </label>

      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? "Guardando…" : "Guardar resolución"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
