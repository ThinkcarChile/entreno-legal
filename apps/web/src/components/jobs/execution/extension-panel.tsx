"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Clock, Timer } from "lucide-react";

import { Amount, Button, Field, Select, Textarea } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { answerExtensionAction, requestExtensionAction } from "@/lib/actions/assignment";
import { startExtensionPaymentAction } from "@/lib/actions/payments";
import { platform } from "@/config/platform";
import type { JobExtension, Payment } from "@/lib/domain/types";
import { PaymentStatus } from "@/lib/domain/enums";
import { formatDuration } from "@/lib/utils/datetime";

/**
 * Tiempo adicional.
 *
 * El trabajador propone, el cliente decide, y el importe lo calcula la base
 * desde la tarifa ya acordada. El acuerdo original no se toca: se suma una
 * extensión, con su propio cobro. Aceptarla no cobra nada por sí misma; deja un
 * pago aparte que el cliente confirma como cualquier otro.
 */

export function ExtensionRequestForm({ assignmentId }: { assignmentId: string }) {
  const router = useRouter();
  const [minutes, setMinutes] = useState(String(platform.extensionPresetsMinutes[0]));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await requestExtensionAction(assignmentId, Number(minutes), reason);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setReason("");
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button variant="outline" fullWidth onClick={() => setOpen(true)}>
        <Timer size={15} aria-hidden="true" />
        Pedir más tiempo
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-control)] border border-ink-200 p-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <Field label="Cuánto tiempo más" htmlFor="extension-minutes">
        <Select
          id="extension-minutes"
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
        >
          {platform.extensionPresetsMinutes.map((value) => (
            <option key={value} value={value}>
              {formatDuration(value)}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Por qué" htmlFor="extension-reason" hint="Lo lee el cliente antes de decidir.">
        <Textarea
          id="extension-reason"
          rows={2}
          maxLength={300}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Ej.: la fila avanza más lento de lo previsto"
        />
      </Field>

      <p className="text-xs text-ink-500">
        Se cobra al cliente a la misma tarifa por hora que acordaron. Tú lo recibes con la misma
        comisión de siempre, y solo si él acepta y paga.
      </p>

      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? "Enviando…" : "Enviar solicitud"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Volver
        </Button>
      </div>
    </div>
  );
}

export function ExtensionAnswer({
  assignmentId,
  extension,
}: {
  assignmentId: string;
  extension: JobExtension;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function answer(accept: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await answerExtensionAction(assignmentId, extension.id, accept);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-control)] border border-warning-100 bg-warning-50/60 p-4">
      <div className="flex items-start gap-2.5">
        <Clock size={17} className="mt-0.5 shrink-0 text-warning-600" aria-hidden="true" />
        <div className="text-sm">
          <p className="font-medium text-ink-900">
            El trabajador pide {formatDuration(extension.additionalMinutes)} más
          </p>
          {extension.reason && <p className="mt-1 text-ink-700">{extension.reason}</p>}
          <p className="mt-1.5 text-ink-700">
            Costo adicional: <Amount value={extension.additionalAmount} />
          </p>
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <p className="text-xs text-ink-600">
        Si aceptas, se crea un cobro aparte por ese tiempo. El trabajo original no cambia de
        precio. La respuesta es definitiva.
      </p>

      <div className="flex gap-2">
        <Button size="sm" onClick={() => answer(true)} disabled={pending}>
          {pending ? "Guardando…" : "Aceptar el tiempo extra"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => answer(false)} disabled={pending}>
          Rechazar
        </Button>
      </div>
    </div>
  );
}

/** El cobro del tiempo adicional aceptado, cuando aún está pendiente. */
export function ExtensionPaymentPrompt({
  extension,
  payment,
}: {
  extension: JobExtension;
  payment: Payment | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (payment?.status === PaymentStatus.PAID) {
    return (
      <p className="text-sm text-success-700">
        Tiempo adicional de {formatDuration(extension.additionalMinutes)} pagado.
      </p>
    );
  }

  function pay() {
    setError(null);
    startTransition(async () => {
      const result = await startExtensionPaymentAction(extension.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      window.location.href = result.data.redirectUrl;
    });
  }

  return (
    <div className="space-y-2.5 rounded-[var(--radius-control)] border border-ink-200 p-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="text-sm text-ink-700">
        Aceptaste {formatDuration(extension.additionalMinutes)} más. Falta pagar{" "}
        <Amount value={extension.additionalAmount} />.
      </p>
      <Button size="sm" onClick={pay} disabled={pending}>
        {pending ? "Preparando el pago…" : "Pagar el tiempo adicional"}
      </Button>
    </div>
  );
}
