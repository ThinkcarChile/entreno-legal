"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { MessageSquare, Send } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { Button, Field, Input, Textarea } from "@/components/ui";
import { openConversationAction } from "@/lib/actions/chat";
import { sendOfferAction, updateOfferAction, withdrawOfferAction } from "@/lib/actions/offers";
import { formatDuration } from "@/lib/utils/datetime";
import { formatMoney, money, proratePerHour } from "@/lib/utils/money";

import type { JobOffer } from "@/lib/domain/types";

const arrivalOptions = [
  { value: 0, label: "A la hora exacta" },
  { value: 15, label: "15 min antes" },
  { value: 30, label: "30 min antes" },
  { value: 60, label: "1 h antes" },
];

/**
 * Envío y edición de una oferta.
 *
 * El precio no se puede editar después de enviada: para cambiarlo hay que
 * retirar la oferta y enviar otra. Es una restricción de la base (privilegio de
 * columna más un trigger) y aquí se explica en vez de ocultarse.
 */
export function OfferForm({
  jobId,
  workerId,
  durationMinutes,
  suggestedHourly,
  existingOffer,
}: {
  jobId: string;
  workerId: string;
  durationMinutes: number;
  suggestedHourly: number;
  existingOffer: JobOffer | null;
}) {
  const router = useRouter();
  const [hourlyRate, setHourlyRate] = useState(
    existingOffer?.hourlyRate.amount ?? suggestedHourly,
  );
  const [arrival, setArrival] = useState(15);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const total = hourlyRate > 0 ? proratePerHour(money(hourlyRate), durationMinutes) : null;
  const editing = existingOffer?.status === "PENDING";

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const message = String(new FormData(event.currentTarget).get("message") ?? "").trim();

    startTransition(async () => {
      const result = editing
        ? await updateOfferAction(existingOffer.id, {
            message,
            arrivalMinutesBefore: arrival,
          })
        : await sendOfferAction({
            jobId,
            hourlyRate,
            message,
            arrivalMinutesBefore: arrival,
          });

      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function withdraw() {
    if (!existingOffer) return;
    setError(null);
    startTransition(async () => {
      const result = await withdrawOfferAction(existingOffer.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function chat() {
    startTransition(async () => {
      const result = await openConversationAction(jobId, workerId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/mensajes/${result.data.conversationId}`);
    });
  }

  if (existingOffer && existingOffer.status !== "PENDING") {
    return (
      <div className="space-y-3">
        <Alert tone={existingOffer.status === "ACCEPTED" ? "success" : "info"}>
          {existingOffer.status === "ACCEPTED"
            ? "Tu oferta fue aceptada. Revisa el trabajo en “Mis trabajos”."
            : existingOffer.status === "REJECTED"
              ? "El cliente eligió otra oferta para este trabajo."
              : "Retiraste tu oferta para este trabajo."}
        </Alert>
        <Button variant="outline" fullWidth onClick={chat} disabled={pending}>
          <MessageSquare size={15} aria-hidden="true" />
          Conversar con el cliente
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <Field
        label="Tu tarifa por hora"
        htmlFor="hourlyRate"
        hint={editing ? "El precio no se puede cambiar. Retira la oferta y envía otra." : undefined}
        required
      >
        <Input
          id="hourlyRate"
          type="number"
          inputMode="numeric"
          min={3000}
          step={500}
          value={hourlyRate || ""}
          disabled={editing}
          onChange={(event) => setHourlyRate(Number(event.target.value))}
        />
      </Field>

      <div className="rounded-[var(--radius-control)] bg-ink-50 px-4 py-3 text-sm">
        <p className="text-ink-500">Tu oferta total</p>
        <p className="mt-0.5 text-xl font-semibold text-ink-900 tabular-nums">
          {total ? formatMoney(total) : "—"}
        </p>
        <p className="mt-0.5 text-xs text-ink-500">
          Por {formatDuration(durationMinutes)} estimadas
        </p>
      </div>

      <Field label="¿A qué hora puedes llegar?" htmlFor="arrival">
        <div className="flex flex-wrap gap-2">
          {arrivalOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={arrival === option.value}
              onClick={() => setArrival(option.value)}
              className={
                arrival === option.value
                  ? "rounded-full border border-brand-600 bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white"
                  : "rounded-full border border-ink-200 bg-white px-3.5 py-1.5 text-sm font-medium text-ink-700 hover:border-brand-300"
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Mensaje al cliente"
        htmlFor="message"
        hint="Cuenta por qué eres buena opción para este trabajo."
      >
        <Textarea
          id="message"
          name="message"
          rows={4}
          maxLength={1000}
          defaultValue={existingOffer?.message ?? ""}
          placeholder="Vivo a diez minutos y hago filas de conciertos todas las semanas."
        />
      </Field>

      {error && <Alert tone="danger">{error}</Alert>}

      <Button type="submit" size="lg" fullWidth disabled={pending}>
        <Send size={16} aria-hidden="true" />
        {pending ? "Enviando…" : editing ? "Actualizar mi oferta" : "Enviar oferta"}
      </Button>

      {editing && (
        <div className="flex gap-2">
          <Button type="button" variant="outline" fullWidth onClick={chat} disabled={pending}>
            <MessageSquare size={15} aria-hidden="true" />
            Conversar
          </Button>
          <Button type="button" variant="ghost" fullWidth onClick={withdraw} disabled={pending}>
            Retirar oferta
          </Button>
        </div>
      )}
    </form>
  );
}
