"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Alert } from "@/components/ui/feedback";
import { Button, Field, Input, Textarea } from "@/components/ui";
import { updateJobAction } from "@/lib/actions/jobs";
import { utcToZonedParts } from "@/lib/utils/datetime";

import type { Job } from "@/lib/domain/types";

/**
 * Edición de un trabajo abierto.
 *
 * Solo aparece mientras el trabajo sigue recibiendo ofertas. Con una oferta ya
 * aceptada hay alguien que organizó su día con estos datos, y cambiarlos en
 * silencio no corresponde: en la etapa siguiente será una solicitud que el
 * trabajador acepta o rechaza.
 */
export function EditJobForm({ job }: { job: Job }) {
  const router = useRouter();
  const start = utcToZonedParts(job.startsAt, job.timezone);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);

    const form = new FormData(event.currentTarget);
    const values = {
      jobId: job.id,
      title: String(form.get("title") ?? "").trim(),
      description: String(form.get("description") ?? "").trim(),
      instructions: String(form.get("instructions") ?? "").trim() || null,
      placeName: String(form.get("placeName") ?? "").trim() || null,
      addressLine: String(form.get("addressLine") ?? "").trim() || undefined,
      addressNotes: String(form.get("addressNotes") ?? "").trim() || null,
      date: String(form.get("date") ?? ""),
      time: String(form.get("time") ?? ""),
      durationMinutes: Number(form.get("durationMinutes") ?? 0) || undefined,
      hourlyRate: Number(form.get("hourlyRate") ?? 0) || undefined,
      bonusAmount: Number(form.get("bonusAmount") ?? 0) || null,
      bonusConditions: String(form.get("bonusConditions") ?? "").trim() || null,
    };

    if (values.title.length < 10) {
      setError("El título necesita al menos 10 caracteres.");
      return;
    }
    if (values.description.length < 30) {
      setError("La descripción necesita al menos 30 caracteres.");
      return;
    }
    if (values.bonusAmount && !values.bonusConditions) {
      setError("Explica en qué condición se paga el bono.");
      return;
    }

    startTransition(async () => {
      const result = await updateJobAction(values);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <Alert tone="info">
        Avisamos a quienes ya ofertaron para que revisen si su oferta sigue vigente.
      </Alert>

      <Field label="Título" htmlFor="title" required>
        <Input id="title" name="title" maxLength={120} defaultValue={job.title} />
      </Field>

      <Field label="Descripción" htmlFor="description" required>
        <Textarea
          id="description"
          name="description"
          rows={5}
          maxLength={2000}
          defaultValue={job.description}
        />
      </Field>

      <Field label="Instrucciones" htmlFor="instructions">
        <Textarea
          id="instructions"
          name="instructions"
          rows={3}
          maxLength={2000}
          defaultValue={job.instructions ?? ""}
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Nombre del lugar" htmlFor="placeName">
          <Input id="placeName" name="placeName" defaultValue={job.location.placeName ?? ""} />
        </Field>
        <Field label="Dirección" htmlFor="addressLine" hint="Solo la ve el trabajador asignado.">
          <Input
            id="addressLine"
            name="addressLine"
            defaultValue={job.location.exact?.addressLine ?? ""}
          />
        </Field>
      </div>

      <Field label="Referencias de acceso" htmlFor="addressNotes">
        <Textarea
          id="addressNotes"
          name="addressNotes"
          rows={2}
          defaultValue={job.location.exact?.addressNotes ?? ""}
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Fecha" htmlFor="date" required>
          <Input id="date" name="date" type="date" defaultValue={start.date} />
        </Field>
        <Field label="Hora de inicio" htmlFor="time" required>
          <Input id="time" name="time" type="time" defaultValue={start.time} />
        </Field>
        <Field label="Duración (min)" htmlFor="durationMinutes" required>
          <Input
            id="durationMinutes"
            name="durationMinutes"
            type="number"
            min={30}
            step={15}
            defaultValue={job.estimatedDurationMinutes}
          />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Tarifa por hora" htmlFor="hourlyRate" required>
          <Input
            id="hourlyRate"
            name="hourlyRate"
            type="number"
            min={3000}
            step={500}
            defaultValue={job.proposedHourlyRate.amount}
          />
        </Field>
        <Field label="Bono" htmlFor="bonusAmount">
          <Input
            id="bonusAmount"
            name="bonusAmount"
            type="number"
            min={0}
            step={1000}
            defaultValue={job.objective.bonus?.amount ?? ""}
          />
        </Field>
        <Field label="¿Cuándo se paga el bono?" htmlFor="bonusConditions">
          <Input
            id="bonusConditions"
            name="bonusConditions"
            defaultValue={job.objective.bonusConditions ?? ""}
          />
        </Field>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {saved && <Alert tone="success">Guardamos los cambios.</Alert>}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Guardando…" : "Guardar cambios"}
      </Button>
    </form>
  );
}
