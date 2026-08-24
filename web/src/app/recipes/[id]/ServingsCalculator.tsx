"use client";

import { useMemo, useState } from "react";
import { NutritionPanel } from "@/components/NutritionPanel";
import { roundQuantityForDisplay, scaleMealTemplateVersion } from "@/domain/recipes/scaling";
import { SLOT_LABELS, type RecipeComponent } from "@/domain/recipes/types";

/**
 * "Calcular para N porciones" (§8). Escala en el cliente con la misma función
 * de dominio que usa el servidor; la receta persistida no se toca.
 */
export function ServingsCalculator({
  components,
  baseServings,
}: {
  components: RecipeComponent[];
  baseServings: number;
}) {
  const [servings, setServings] = useState(baseServings);

  const scaled = useMemo(() => {
    if (!Number.isFinite(servings) || servings <= 0) return null;
    return scaleMealTemplateVersion({ baseServings, components }, servings);
  }, [components, baseServings, servings]);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3 rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
        <label htmlFor="servings" className="text-sm font-medium">
          Calcular para
        </label>
        <input
          id="servings"
          type="number"
          min={1}
          max={50}
          value={servings}
          onChange={(e) => setServings(Number(e.target.value))}
          className="w-20 rounded-xl border border-[var(--ink)]/20 px-3 py-1.5 text-center text-base"
        />
        <span className="text-sm text-[var(--ink)]/70">
          {servings === 1 ? "persona" : "personas"}
        </span>
        {servings !== baseServings && (
          <button
            type="button"
            onClick={() => setServings(baseServings)}
            className="ml-auto text-xs text-[var(--accent)] underline"
          >
            Volver a {baseServings}
          </button>
        )}
      </div>

      {!scaled ? (
        <p className="text-sm text-[var(--ink)]/60">Indica cuántas personas van a comer.</p>
      ) : (
        <>
          <ul className="divide-y divide-[var(--ink)]/5 rounded-2xl border border-[var(--ink)]/10 bg-white">
            {scaled.components.map((component) => (
              <li key={component.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                <div>
                  <p className="text-sm font-medium">
                    {component.label}
                    {component.isOptional && (
                      <span className="ml-2 text-[11px] font-normal text-[var(--ink)]/50">
                        opcional
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-[var(--ink)]/50">
                    {SLOT_LABELS[component.slotType]}
                  </p>
                </div>
                <p className="shrink-0 text-sm tabular-nums">
                  {roundQuantityForDisplay(component.quantity).toLocaleString("es-CL")}{" "}
                  {component.unit === "G" ? "g" : "ml"}
                  {servings !== baseServings && (
                    <span className="ml-2 text-[11px] text-[var(--ink)]/40">
                      (base {roundQuantityForDisplay(component.baseQuantity).toLocaleString("es-CL")})
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>

          <NutritionPanel
            title={`Total para ${servings} ${servings === 1 ? "persona" : "personas"}`}
            nutrition={scaled.nutrition.total}
          />
          <NutritionPanel title="Por porción" nutrition={scaled.nutrition.perServing} compact />
        </>
      )}
    </section>
  );
}
