"use client";

import { useMemo, useState, useTransition } from "react";

import { Plus, X } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { saveWorkerProfileAction } from "@/lib/actions/account";
import { getCommunes, regions } from "@/lib/geo/chile";

import type { WorkerProfile } from "@/lib/domain/types";

interface AreaDraft {
  regionCode: string;
  communeCode: string | null;
  radiusKm: number | null;
}

/**
 * Perfil de trabajador.
 *
 * Lo que aquí se guarda es todo público salvo el teléfono, que vive en la tabla
 * privada y se pide en el onboarding. El estado de verificación no se toca desde
 * aquí: el usuario no tiene privilegio sobre esa columna.
 */
export function WorkerProfileForm({ worker }: { worker: WorkerProfile | null }) {
  const [areas, setAreas] = useState<AreaDraft[]>(
    worker && worker.serviceAreas.length > 0
      ? worker.serviceAreas.map((a) => ({
          regionCode: a.regionCode,
          communeCode: a.communeCode,
          radiusKm: a.radiusKm,
        }))
      : [{ regionCode: "", communeCode: null, radiusKm: 15 }],
  );
  const [acceptsOvernight, setAcceptsOvernight] = useState(worker?.acceptsOvernight ?? false);
  const [isAccepting, setIsAccepting] = useState(worker?.isAcceptingJobs ?? false);
  const [acceptsTerms, setAcceptsTerms] = useState(Boolean(worker?.headline));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const canAcceptJobs = worker?.verificationStatus === "VERIFIED";

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);

    if (!acceptsTerms) {
      setError("Debes aceptar las reglas de uso para ofrecer tus servicios.");
      return;
    }

    const form = new FormData(event.currentTarget);
    const cleanAreas = areas.filter((a) => a.regionCode);

    if (cleanAreas.length === 0) {
      setError("Indica al menos una zona donde trabajas.");
      return;
    }

    const values = {
      headline: String(form.get("headline") ?? "").trim(),
      bio: String(form.get("bio") ?? "").trim(),
      baseHourlyRate: Number(form.get("baseHourlyRate") ?? 0),
      availabilityNote: String(form.get("availabilityNote") ?? "").trim(),
      acceptsOvernight,
      isAcceptingJobs: canAcceptJobs ? isAccepting : false,
      areas: cleanAreas,
    };

    startTransition(async () => {
      const result = await saveWorkerProfileAction(values);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      <Field
        label="Descripción breve"
        htmlFor="headline"
        hint="Una línea que resuma lo que haces. Es lo primero que lee el cliente."
        required
      >
        <Input
          id="headline"
          name="headline"
          maxLength={160}
          defaultValue={worker?.headline ?? ""}
          placeholder="Filas de conciertos y lanzamientos en el centro de Santiago"
        />
      </Field>

      <Field
        label="Sobre ti"
        htmlFor="bio"
        hint="Opcional. Cuenta tu experiencia y cómo trabajas."
      >
        <Textarea
          id="bio"
          name="bio"
          rows={4}
          maxLength={1000}
          defaultValue={worker?.profile.bio ?? ""}
          placeholder="Hago filas desde 2024. Llego antes de la hora y mando fotos cada hora."
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Tarifa base por hora"
          htmlFor="baseHourlyRate"
          hint="En pesos. Es una referencia: en cada oferta decides el precio."
          required
        >
          <Input
            id="baseHourlyRate"
            name="baseHourlyRate"
            type="number"
            inputMode="numeric"
            min={3000}
            step={500}
            defaultValue={worker?.baseHourlyRate.amount || ""}
            placeholder="10000"
          />
        </Field>

        <Field label="Disponibilidad" htmlFor="availabilityNote" required>
          <Input
            id="availabilityNote"
            name="availabilityNote"
            maxLength={300}
            defaultValue={worker?.availabilityNote ?? ""}
            placeholder="Lunes a domingo, incluidas madrugadas"
          />
        </Field>
      </div>

      <fieldset>
        <legend className="text-small font-medium text-ink-800">Zonas donde trabajas</legend>
        <p className="mt-1 text-small text-ink-500">
          Deja la comuna en blanco para cubrir toda la región.
        </p>

        <div className="mt-3 space-y-3">
          {areas.map((area, index) => (
            <AreaRow
              key={index}
              area={area}
              canRemove={areas.length > 1}
              onChange={(next) =>
                setAreas((current) => current.map((a, i) => (i === index ? next : a)))
              }
              onRemove={() => setAreas((current) => current.filter((_, i) => i !== index))}
            />
          ))}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() =>
            setAreas((current) => [...current, { regionCode: "", communeCode: null, radiusKm: 15 }])
          }
        >
          <Plus size={15} aria-hidden="true" />
          Agregar zona
        </Button>
      </fieldset>

      <div className="space-y-3 rounded-[var(--radius-card)] border border-line bg-surface p-5">
        <label className="flex cursor-pointer items-start gap-3 text-small text-ink-700">
          <input
            type="checkbox"
            checked={acceptsOvernight}
            onChange={(event) => setAcceptsOvernight(event.target.checked)}
            className="mt-0.5 h-4.5 w-4.5 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
          />
          <span>Acepto trabajos nocturnos y de madrugada.</span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 text-small text-ink-700">
          <input
            type="checkbox"
            checked={isAccepting}
            disabled={!canAcceptJobs}
            onChange={(event) => setIsAccepting(event.target.checked)}
            className="mt-0.5 h-4.5 w-4.5 rounded border-ink-300 text-brand-600 focus:ring-brand-500 disabled:opacity-40"
          />
          <span className={canAcceptJobs ? "" : "text-ink-500"}>
            Aparecer como disponible para recibir invitaciones.
            {!canAcceptJobs && " Se habilita cuando tu identidad esté verificada."}
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 text-small text-ink-700">
          <input
            type="checkbox"
            checked={acceptsTerms}
            onChange={(event) => setAcceptsTerms(event.target.checked)}
            className="mt-0.5 h-4.5 w-4.5 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
          />
          <span>
            Acepto las reglas de uso y entiendo que no puedo suplantar la identidad de nadie ni
            realizar trámites que exijan la presencia del titular.
          </span>
        </label>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {saved && <Alert tone="success">Guardamos tu perfil de trabajador.</Alert>}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Guardando…" : "Guardar perfil"}
      </Button>
    </form>
  );
}

function AreaRow({
  area,
  canRemove,
  onChange,
  onRemove,
}: {
  area: AreaDraft;
  canRemove: boolean;
  onChange: (next: AreaDraft) => void;
  onRemove: () => void;
}) {
  const communes = useMemo(
    () => (area.regionCode ? getCommunes(area.regionCode) : []),
    [area.regionCode],
  );

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-[var(--radius-control)] border border-line p-3">
      <div className="min-w-44 flex-1">
        <label className="mb-1 block text-caption font-medium text-ink-600">Región</label>
        <Select
          value={area.regionCode}
          onChange={(event) =>
            onChange({ ...area, regionCode: event.target.value, communeCode: null })
          }
        >
          <option value="">Selecciona</option>
          {regions.map((region) => (
            <option key={region.code} value={region.code}>
              {region.shortName}
            </option>
          ))}
        </Select>
      </div>

      <div className="min-w-44 flex-1">
        <label className="mb-1 block text-caption font-medium text-ink-600">Comuna</label>
        <Select
          value={area.communeCode ?? ""}
          disabled={communes.length === 0}
          onChange={(event) => onChange({ ...area, communeCode: event.target.value || null })}
        >
          <option value="">Toda la región</option>
          {communes.map((commune) => (
            <option key={commune.code} value={commune.code}>
              {commune.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="w-28">
        <label className="mb-1 block text-caption font-medium text-ink-600">Radio (km)</label>
        <Input
          type="number"
          min={1}
          max={200}
          value={area.radiusKm ?? ""}
          onChange={(event) =>
            onChange({ ...area, radiusKm: event.target.value ? Number(event.target.value) : null })
          }
        />
      </div>

      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Quitar zona"
          className="mb-1 inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-ink-500 hover:bg-ink-100"
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
