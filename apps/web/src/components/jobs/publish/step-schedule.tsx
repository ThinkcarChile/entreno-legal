"use client";

import { Moon } from "lucide-react";

import { Field, Input } from "@/components/ui";
import { platform } from "@/config/platform";
import { timezoneFor } from "@/lib/geo/chile";
import { cn } from "@/lib/utils/cn";
import { formatDuration, isOvernight, zonedInputToUtc } from "@/lib/utils/datetime";

import type { StepProps } from "./types";

const durationPresets = [30, 60, 120, 240, 360, 480, 720, 1440];

export function StepSchedule({ draft, errors, update }: StepProps) {
  const timezone = timezoneFor(draft.regionCode ?? "13", draft.communeCode);
  const duration = draft.durationMinutes ?? 0;

  const overnight =
    draft.date && draft.time && duration > 0
      ? isOvernight(zonedInputToUtc(draft.date, draft.time, timezone), duration, timezone)
      : false;

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Fecha" htmlFor="date" error={errors.date} required>
          <Input
            id="date"
            type="date"
            min={today}
            value={draft.date ?? ""}
            aria-invalid={Boolean(errors.date)}
            onChange={(event) => update({ date: event.target.value })}
          />
        </Field>

        <Field
          label="Hora de inicio"
          htmlFor="time"
          error={errors.time}
          hint="Se guarda en la zona horaria del lugar del trabajo."
          required
        >
          <Input
            id="time"
            type="time"
            value={draft.time ?? ""}
            aria-invalid={Boolean(errors.time)}
            onChange={(event) => update({ time: event.target.value })}
          />
        </Field>
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-ink-800">
          Duración estimada <span className="text-danger-600">*</span>
        </legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {durationPresets.map((minutes) => (
            <button
              key={minutes}
              type="button"
              aria-pressed={duration === minutes}
              onClick={() => update({ durationMinutes: minutes })}
              className={cn(
                "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                duration === minutes
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-ink-200 bg-white text-ink-700 hover:border-brand-300",
              )}
            >
              {formatDuration(minutes)}
            </button>
          ))}
        </div>

        <div className="mt-4 max-w-xs">
          <Field
            label="O ingresa los minutos exactos"
            htmlFor="durationMinutes"
            error={errors.durationMinutes}
          >
            <Input
              id="durationMinutes"
              type="number"
              inputMode="numeric"
              min={platform.minDurationMinutes}
              step={15}
              value={duration || ""}
              aria-invalid={Boolean(errors.durationMinutes)}
              onChange={(event) => update({ durationMinutes: Number(event.target.value) })}
            />
          </Field>
        </div>

        <p className="mt-3 text-sm text-ink-500">
          No hay duración máxima. Si el trabajo se alarga, puedes solicitar una extensión y el
          trabajador decide si la acepta.
        </p>
      </fieldset>

      {overnight && (
        <div className="flex gap-3 rounded-[var(--radius-control)] border border-brand-100 bg-brand-50/60 p-4 text-sm text-brand-800">
          <Moon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            Este trabajo cruza la madrugada. Se marca como nocturno y el precio sugerido sube,
            porque menos personas están disponibles a esa hora.
          </p>
        </div>
      )}
    </div>
  );
}
