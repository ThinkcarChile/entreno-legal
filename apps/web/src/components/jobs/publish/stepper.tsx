import { Check } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export interface StepperProps {
  steps: readonly { id: string; title: string }[];
  current: number;
}

/** Progreso del asistente. En móvil se reduce a una barra para no robar altura. */
export function Stepper({ steps, current }: StepperProps) {
  const percent = Math.round(((current + 1) / steps.length) * 100);

  return (
    <div>
      <div className="sm:hidden">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-medium text-ink-900">{steps[current]?.title}</p>
          <p className="text-xs text-ink-500 tabular-nums">
            Paso {current + 1} de {steps.length}
          </p>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-200">
          <div
            className="h-full rounded-full bg-brand-600 transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <ol className="hidden sm:flex sm:items-center sm:gap-2">
        {steps.map((step, index) => {
          const done = index < current;
          const active = index === current;

          return (
            <li key={step.id} className="flex flex-1 items-center gap-2">
              <span
                className={cn(
                  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  done && "bg-brand-600 text-white",
                  active && "bg-brand-50 text-brand-700 ring-2 ring-brand-600",
                  !done && !active && "bg-ink-100 text-ink-500",
                )}
              >
                {done ? <Check size={14} aria-hidden="true" /> : index + 1}
              </span>
              <span
                className={cn(
                  "hidden truncate text-xs font-medium lg:block",
                  active ? "text-ink-900" : "text-ink-500",
                )}
              >
                {step.title}
              </span>
              {index < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn("h-px flex-1", done ? "bg-brand-600" : "bg-ink-200")}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
