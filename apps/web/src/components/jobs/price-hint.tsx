import { Info } from "lucide-react";

import { AmountRange } from "@/components/ui";

import type { PriceSuggestion } from "@/lib/pricing";

/**
 * Precio sugerido.
 *
 * Se muestran los factores aplicados para que el cliente entienda de dónde sale el
 * rango. La plataforma nunca fija el precio final: cada trabajador cobra lo suyo.
 */
export function PriceHint({ suggestion }: { suggestion: PriceSuggestion }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-brand-100 bg-brand-50/60 p-5">
      <p className="flex items-center gap-2 text-sm font-medium text-brand-800">
        <Info size={15} aria-hidden="true" />
        Precio sugerido para este trabajo
      </p>

      <p className="mt-2 text-2xl font-semibold text-ink-900">
        <AmountRange min={suggestion.hourlyMin} max={suggestion.hourlyMax} />
        <span className="ml-1 text-base font-normal text-ink-600">por hora</span>
      </p>

      <p className="mt-1 text-sm text-ink-600">
        Estimado total entre{" "}
        <AmountRange
          min={suggestion.totalMin}
          max={suggestion.totalMax}
          className="font-medium text-ink-800"
        />
      </p>

      {suggestion.factors.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {suggestion.factors.map((factor) => (
            <li
              key={factor.code}
              className="rounded-full bg-white px-2.5 py-1 text-xs text-ink-600 ring-1 ring-brand-100 ring-inset"
            >
              {factor.label}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-ink-500">
        Es una referencia. Cada trabajador decide cuánto cobrar y tú eliges la oferta que
        prefieras.
      </p>
    </div>
  );
}
