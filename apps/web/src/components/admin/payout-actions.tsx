"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button, Field, Input } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import {
  approvePayoutAction,
  holdPayoutAction,
  markPayoutPaidAction,
} from "@/lib/actions/admin";
import { PayoutStatus } from "@/lib/domain/enums";

/**
 * Acciones sobre el pago a un trabajador.
 *
 * «Registrar transferencia» es exactamente eso: anotar algo que una persona
 * hizo por fuera, con su referencia. La plataforma no transfiere dinero en esta
 * etapa y la pantalla no finge lo contrario.
 */
export function PayoutActions({
  payoutId,
  status,
}: {
  payoutId: string;
  status: PayoutStatus;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"none" | "pay" | "hold">("none");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "No pudimos completar la acción.");
        return;
      }
      setMode("none");
      router.refresh();
    });
  }

  if (status === PayoutStatus.PAID || status === PayoutStatus.CANCELLED) return null;

  return (
    <div className="w-full space-y-2.5 sm:max-w-sm">
      {error && <Alert tone="danger">{error}</Alert>}

      {mode === "pay" && (
        <div className="space-y-2.5 rounded-[var(--radius-control)] border border-ink-200 p-3">
          <Field label="Referencia de la transferencia" htmlFor={`ref-${payoutId}`} required>
            <Input
              id={`ref-${payoutId}`}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Ej.: TRX-2026-0001"
              maxLength={80}
            />
          </Field>
          <p className="text-xs text-ink-500">
            Se registra un pago ya realizado fuera de la plataforma. No se envía dinero desde aquí.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => run(() => markPayoutPaidAction(payoutId, reference))}
              disabled={pending}
            >
              {pending ? "Registrando…" : "Registrar transferencia"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMode("none")} disabled={pending}>
              Volver
            </Button>
          </div>
        </div>
      )}

      {mode === "hold" && (
        <div className="space-y-2.5 rounded-[var(--radius-control)] border border-ink-200 p-3">
          <Field label="Motivo de la retención" htmlFor={`hold-${payoutId}`} required>
            <Input
              id={`hold-${payoutId}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={200}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              variant="danger"
              size="sm"
              onClick={() => run(() => holdPayoutAction(payoutId, reason))}
              disabled={pending}
            >
              {pending ? "Reteniendo…" : "Retener"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMode("none")} disabled={pending}>
              Volver
            </Button>
          </div>
        </div>
      )}

      {mode === "none" && (
        <div className="flex flex-wrap gap-2">
          {(status === PayoutStatus.PENDING || status === PayoutStatus.HELD) && (
            <Button size="sm" onClick={() => run(() => approvePayoutAction(payoutId))} disabled={pending}>
              Aprobar
            </Button>
          )}
          {status === PayoutStatus.APPROVED && (
            <Button size="sm" onClick={() => setMode("pay")} disabled={pending}>
              Registrar transferencia
            </Button>
          )}
          {status !== PayoutStatus.HELD && (
            <Button variant="outline" size="sm" onClick={() => setMode("hold")} disabled={pending}>
              Retener
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
