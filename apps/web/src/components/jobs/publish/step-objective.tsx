"use client";

import { Field, Input, Textarea } from "@/components/ui";
import { CategoryGroup, JobObjectiveType } from "@/lib/domain/enums";
import { cn } from "@/lib/utils/cn";
import { formatMoney, money } from "@/lib/utils/money";

import type { StepProps } from "./types";
import type { JobCategory } from "@/lib/domain/types";

const queueObjectives = [
  { id: JobObjectiveType.HOLD_PLACE, label: "Mantener el lugar", description: "Guardar el puesto hasta que llegues." },
  {
    id: JobObjectiveType.AS_FRONT_AS_POSSIBLE,
    label: "Quedar lo más adelante posible",
    description: "Llegar temprano y avanzar todo lo que se pueda.",
  },
  {
    id: JobObjectiveType.WITHIN_FIRST_N,
    label: "Estar dentro de los primeros X",
    description: "Objetivo medible, apto para bono.",
  },
  { id: JobObjectiveType.CUSTOM, label: "Personalizado", description: "Describe tú el objetivo." },
];

const errandObjectives = [
  {
    id: JobObjectiveType.COMPLETE_ERRAND,
    label: "Completar la gestión",
    description: "Realizar el encargo y entregar el comprobante.",
  },
  { id: JobObjectiveType.CUSTOM, label: "Personalizado", description: "Describe tú el objetivo." },
];

export function StepObjective({
  draft,
  errors,
  update,
  categories,
}: StepProps & { categories: readonly JobCategory[] }) {
  const category = categories.find((c) => c.id === draft.categoryId);
  const options = category?.group === CategoryGroup.TRAMITE ? errandObjectives : queueObjectives;
  const bonus = draft.bonusAmount ?? 0;

  return (
    <div className="space-y-8">
      <fieldset>
        <legend className="text-sm font-medium text-ink-800">
          ¿Cuál es el objetivo? <span className="text-danger-600">*</span>
        </legend>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {options.map((option) => {
            const active = draft.objectiveType === option.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => update({ objectiveType: option.id })}
                className={cn(
                  "rounded-[var(--radius-control)] border px-4 py-3 text-left transition-colors",
                  active
                    ? "border-brand-600 bg-brand-50/60 ring-1 ring-brand-600"
                    : "border-ink-200 bg-white hover:border-brand-200",
                )}
              >
                <span className="block text-sm font-medium text-ink-900">{option.label}</span>
                <span className="mt-0.5 block text-xs text-ink-500">{option.description}</span>
              </button>
            );
          })}
        </div>
        {errors.objectiveType && (
          <p className="mt-2 text-sm text-danger-600" role="alert">
            {errors.objectiveType}
          </p>
        )}
      </fieldset>

      {draft.objectiveType === JobObjectiveType.WITHIN_FIRST_N && (
        <div className="max-w-xs">
          <Field
            label="¿Dentro de cuántos lugares?"
            htmlFor="targetPosition"
            error={errors.targetPosition}
            required
          >
            <Input
              id="targetPosition"
              type="number"
              inputMode="numeric"
              min={1}
              value={draft.targetPosition ?? ""}
              aria-invalid={Boolean(errors.targetPosition)}
              onChange={(event) => update({ targetPosition: Number(event.target.value) })}
            />
          </Field>
        </div>
      )}

      {(draft.objectiveType === JobObjectiveType.CUSTOM ||
        draft.objectiveType === JobObjectiveType.COMPLETE_ERRAND) && (
        <Field
          label="Describe el objetivo"
          htmlFor="objectiveDescription"
          error={errors.objectiveDescription}
          required={draft.objectiveType === JobObjectiveType.CUSTOM}
        >
          <Textarea
            id="objectiveDescription"
            rows={3}
            value={draft.objectiveDescription ?? ""}
            aria-invalid={Boolean(errors.objectiveDescription)}
            placeholder="Retirar el pedido y dejarlo en conserjería a nombre del cliente."
            onChange={(event) => update({ objectiveDescription: event.target.value })}
          />
        </Field>
      )}

      <div className="rounded-[var(--radius-card)] border border-ink-200 bg-white p-5">
        <h3 className="font-semibold text-ink-900">Bono por objetivo</h3>
        <p className="mt-1.5 text-sm text-ink-600">
          Opcional. El bono es distinto del pago por trabajo: si la persona hizo bien su trabajo
          pero un factor externo impidió alcanzar el objetivo, recibe el pago por tiempo y no el
          bono.
        </p>

        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <Field label="Monto del bono" htmlFor="bonusAmount" error={errors.bonusAmount}>
            <Input
              id="bonusAmount"
              type="number"
              inputMode="numeric"
              min={0}
              step={1000}
              value={bonus || ""}
              placeholder="15000"
              onChange={(event) => update({ bonusAmount: Number(event.target.value) })}
            />
          </Field>

          <Field
            label="¿Cuándo se paga?"
            htmlFor="bonusConditions"
            error={errors.bonusConditions}
            required={bonus > 0}
          >
            <Input
              id="bonusConditions"
              value={draft.bonusConditions ?? ""}
              aria-invalid={Boolean(errors.bonusConditions)}
              placeholder="Si quedas entre los primeros 10"
              onChange={(event) => update({ bonusConditions: event.target.value })}
            />
          </Field>
        </div>

        {bonus > 0 && (
          <p className="mt-3 text-sm text-ink-600">
            Se sumará <span className="font-medium text-ink-900">{formatMoney(money(bonus))}</span>{" "}
            al total solo si el objetivo se cumple.
          </p>
        )}
      </div>
    </div>
  );
}
