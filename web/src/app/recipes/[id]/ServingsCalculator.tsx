"use client";

import { useMemo, useState } from "react";
import { NutritionPanel } from "@/components/NutritionPanel";
import { Card } from "@/components/ui";
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
    <section className="space-y-sm">
      <Card className="flex flex-wrap items-center gap-sm p-md">
        <label
          htmlFor="servings"
          className="font-body-md text-body-md font-semibold text-on-surface"
        >
          Calcular para
        </label>
        <input
          id="servings"
          type="number"
          min={1}
          max={50}
          value={servings}
          onChange={(e) => setServings(Number(e.target.value))}
          className="min-h-[48px] w-20 rounded-xl border border-outline-variant bg-surface-container-lowest px-sm py-2 text-center font-body-md text-body-md text-on-surface"
        />
        <span className="font-body-sm text-body-sm text-on-surface-variant">
          {servings === 1 ? "persona" : "personas"}
        </span>
        {servings !== baseServings && (
          <button
            type="button"
            onClick={() => setServings(baseServings)}
            className="ml-auto font-body-sm text-body-sm font-semibold text-primary underline"
          >
            Volver a {baseServings}
          </button>
        )}
      </Card>

      {!scaled ? (
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Indica cuántas personas van a comer.
        </p>
      ) : (
        <>
          <Card className="px-md py-xs">
            <ul>
              {scaled.components.map((component) => (
                <li
                  key={component.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-md gap-y-1 border-b border-outline-variant/40 py-sm last:border-0"
                >
                  <div className="min-w-0">
                    <p className="font-body-md text-body-md text-on-surface">
                      {component.label}
                      {component.isOptional && (
                        <span className="ml-2 font-label-md text-label-md text-on-surface-variant">
                          opcional
                        </span>
                      )}
                    </p>
                    <p className="font-label-md text-label-md text-on-surface-variant">
                      {SLOT_LABELS[component.slotType]}
                    </p>
                  </div>
                  <p className="shrink-0 font-body-md text-body-md tabular-nums text-on-surface">
                    {roundQuantityForDisplay(component.quantity).toLocaleString("es-CL")}{" "}
                    {component.unit === "G" ? "g" : "ml"}
                    {servings !== baseServings && (
                      <span className="ml-2 font-label-md text-label-md text-outline">
                        (base{" "}
                        {roundQuantityForDisplay(component.baseQuantity).toLocaleString("es-CL")})
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </Card>

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
