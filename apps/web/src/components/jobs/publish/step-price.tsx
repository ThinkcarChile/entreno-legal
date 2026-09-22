"use client";

import { PriceHint } from "@/components/jobs/price-hint";
import { Field, Input } from "@/components/ui";
import { JobUrgency } from "@/lib/domain/enums";
import { urgencyLabels } from "@/lib/domain/labels";
import { cn } from "@/lib/utils/cn";
import { formatDuration } from "@/lib/utils/datetime";
import { formatMoney, money, proratePerHour } from "@/lib/utils/money";

import type { StepProps } from "./types";
import type { PriceSuggestion } from "@/lib/pricing";

export function StepPrice({
  draft,
  errors,
  update,
  suggestion,
}: StepProps & { suggestion: PriceSuggestion | null }) {
  const duration = draft.durationMinutes ?? 0;
  const hourly = draft.hourlyRate ?? 0;
  const total = hourly > 0 && duration > 0 ? proratePerHour(money(hourly), duration) : null;

  return (
    <div className="space-y-6">
      {suggestion && <PriceHint suggestion={suggestion} />}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Tu tarifa por hora"
          htmlFor="hourlyRate"
          error={errors.hourlyRate}
          hint="En pesos chilenos. Puedes moverte dentro o fuera del rango sugerido."
          required
        >
          <Input
            id="hourlyRate"
            type="number"
            inputMode="numeric"
            min={3000}
            step={500}
            value={hourly || ""}
            aria-invalid={Boolean(errors.hourlyRate)}
            placeholder={String(suggestion?.recommendedHourly.amount ?? 10000)}
            onChange={(event) => update({ hourlyRate: Number(event.target.value) })}
          />
        </Field>

        <div className="rounded-[var(--radius-control)] border border-line bg-ink-50/60 p-4">
          <p className="text-small text-ink-500">Presupuesto propuesto</p>
          <p className="mt-1 text-2xl font-semibold text-ink-950 tabular-nums">
            {total ? formatMoney(total) : "—"}
          </p>
          <p className="mt-0.5 text-caption text-ink-500">
            {duration > 0 ? `Por ${formatDuration(duration)} estimadas` : "Define la duración"}
          </p>
          {draft.bonusAmount ? (
            <p className="mt-2 text-caption text-ink-500">
              Más {formatMoney(money(draft.bonusAmount))} de bono si se cumple el objetivo.
            </p>
          ) : null}
        </div>
      </div>

      <fieldset>
        <legend className="text-small font-medium text-ink-800">¿Qué tan urgente es?</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {(
            [JobUrgency.FLEXIBLE, JobUrgency.NORMAL, JobUrgency.URGENTE] as const
          ).map((urgency) => {
            const active = (draft.urgency ?? JobUrgency.NORMAL) === urgency;
            return (
              <button
                key={urgency}
                type="button"
                aria-pressed={active}
                onClick={() => update({ urgency })}
                className={cn(
                  "rounded-full border px-4 py-2 text-small font-medium transition-colors",
                  active
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-line bg-surface text-ink-700 hover:border-brand-300",
                )}
              >
                {urgencyLabels[urgency].label}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-small text-ink-500">
          Marcar un trabajo como urgente lo destaca y sube el precio sugerido, porque exige
          disponibilidad inmediata.
        </p>
      </fieldset>
    </div>
  );
}
