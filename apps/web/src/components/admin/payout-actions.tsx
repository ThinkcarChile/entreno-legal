"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button, Field, Input, Textarea } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import {
  adjustPayoutAction,
  approvePayoutAction,
  holdPayoutAction,
  markPayoutPaidAction,
} from "@/lib/actions/admin";
import { PayoutStatus } from "@/lib/domain/enums";
import { adjustmentSummary, checkPayoutAdjustment } from "@/lib/validation/payout-adjustment";

/**
 * Acciones sobre el pago a un trabajador.
 *
 * «Registrar transferencia» es exactamente eso: anotar algo que una persona
 * hizo por fuera, con su referencia. La plataforma no transfiere dinero en esta
 * etapa y la pantalla no finge lo contrario.
 *
 * «Ajustar» baja el neto de un pago que todavía no se transfirió, o lo cancela
 * con $0: es la salida de un payout retenido porque una devolución dejó las
 * cifras sin cuadrar. Pide el motivo —lo lee el trabajador— y una confirmación
 * con las dos cifras escritas, porque cambia lo que alguien va a cobrar.
 */
export function PayoutActions({
  payoutId,
  status,
  netAmount,
}: {
  payoutId: string;
  status: PayoutStatus;
  /** Neto actual, en pesos: el tope del ajuste. */
  netAmount: number;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"none" | "pay" | "hold" | "adjust">("none");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [newNet, setNewNet] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    setNotice(null);
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

  function openAdjust() {
    setError(null);
    setNotice(null);
    setNewNet("");
    setAdjustReason("");
    setConfirmed(false);
    setMode("adjust");
  }

  // Un campo vacío no es $0: cancelar tiene que escribirse.
  const parsedNet = newNet.trim() === "" ? Number.NaN : Number(newNet);
  const adjustment = checkPayoutAdjustment(netAmount, parsedNet, adjustReason);

  function adjust() {
    if (!adjustment.ok || !confirmed) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await adjustPayoutAction(payoutId, adjustment.netAmount, adjustReason);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMode("none");
      if (result.data.overrun) {
        setNotice(
          `Ajustado, pero las cifras todavía no cuadran: ${result.data.overrun}. ` +
            "La aprobación y la transferencia se seguirán negando hasta que cuadren.",
        );
      }
      router.refresh();
    });
  }

  if (status === PayoutStatus.PAID || status === PayoutStatus.CANCELLED) return null;

  const adjustable =
    status === PayoutStatus.PENDING ||
    status === PayoutStatus.APPROVED ||
    status === PayoutStatus.HELD;

  return (
    <div className="w-full space-y-2.5 sm:max-w-sm">
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="warning">{notice}</Alert>}

      {mode === "pay" && (
        <div className="space-y-2.5 rounded-[var(--radius-control)] border border-line p-3">
          <Field label="Referencia de la transferencia" htmlFor={`ref-${payoutId}`} required>
            <Input
              id={`ref-${payoutId}`}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Ej.: TRX-2026-0001"
              maxLength={80}
            />
          </Field>
          <p className="text-caption text-ink-500">
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
        <div className="space-y-2.5 rounded-[var(--radius-control)] border border-line p-3">
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

      {mode === "adjust" && (
        <div className="space-y-2.5 rounded-[var(--radius-control)] border border-line p-3">
          <Field
            label="Nuevo neto para el trabajador (CLP)"
            htmlFor={`net-${payoutId}`}
            hint="Solo baja. Con 0 se cancela el pago."
            error={
              newNet.trim() !== "" && !adjustment.ok && adjustment.field === "netAmount"
                ? adjustment.error
                : undefined
            }
            required
          >
            <Input
              id={`net-${payoutId}`}
              type="number"
              inputMode="numeric"
              min={0}
              max={netAmount}
              step={1}
              value={newNet}
              onChange={(event) => {
                setNewNet(event.target.value);
                setConfirmed(false);
              }}
            />
          </Field>
          <Field
            label="Motivo"
            htmlFor={`adjust-${payoutId}`}
            hint="Lo lee el trabajador, y queda en la auditoría junto a tu nombre. Al menos 10 caracteres."
            required
          >
            <Textarea
              id={`adjust-${payoutId}`}
              rows={3}
              maxLength={500}
              value={adjustReason}
              onChange={(event) => setAdjustReason(event.target.value)}
            />
          </Field>

          {adjustment.ok && (
            <label className="flex items-start gap-2 text-small text-ink-700">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-brand-600"
              />
              <span>
                Confirmo: {adjustmentSummary(netAmount, adjustment.netAmount)} No se puede volver a
                subir desde aquí.
              </span>
            </label>
          )}

          <div className="flex gap-2">
            <Button
              variant="danger"
              size="sm"
              onClick={adjust}
              disabled={pending || !adjustment.ok || !confirmed}
            >
              {pending
                ? "Ajustando…"
                : adjustment.ok && adjustment.cancels
                  ? "Cancelar el pago"
                  : "Ajustar"}
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
          {adjustable && (
            <Button variant="outline" size="sm" onClick={openAdjust} disabled={pending}>
              Ajustar
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
