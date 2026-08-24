import {
  COMPLETENESS_LABELS,
  NUTRIENT_KEYS,
  NUTRIENT_LABELS,
  type AggregatedNutrition,
} from "@/domain/catalog/types";
import { roundForDisplay } from "@/domain/catalog/nutrition";

/**
 * Muestra una agregación nutricional sin mentir: un valor PARCIAL nunca se
 * presenta como si fuera el total, y un desconocido nunca se muestra como 0
 * (ADR 0002 §5).
 */
export function NutritionPanel({
  title,
  nutrition,
  compact = false,
}: {
  title: string;
  nutrition: AggregatedNutrition;
  compact?: boolean;
}) {
  const keys = compact
    ? (["energy_kcal", "protein_g", "carbohydrates_g", "fat_g"] as const)
    : NUTRIENT_KEYS;

  const incomplete = NUTRIENT_KEYS.filter((k) => nutrition.completeness[k] === "PARTIAL");

  return (
    <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
        {title}
      </h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {keys.map((key) => {
          const state = nutrition.completeness[key];
          const value = nutrition.values[key];
          const rounded = roundForDisplay(value, key === "energy_kcal" ? 0 : 1);
          return (
            <div key={key}>
              <dt className="text-xs text-[var(--ink)]/60">{NUTRIENT_LABELS[key].label}</dt>
              <dd className="text-base font-medium">
                {state === "UNKNOWN" || rounded === null ? (
                  <span className="text-[var(--ink)]/40">Sin datos</span>
                ) : (
                  <>
                    {state === "PARTIAL" && <span aria-hidden>≥ </span>}
                    {rounded.toLocaleString("es-CL")}{" "}
                    <span className="text-xs font-normal text-[var(--ink)]/60">
                      {NUTRIENT_LABELS[key].unit}
                    </span>
                  </>
                )}
              </dd>
              {state === "PARTIAL" && (
                <p className="text-[11px] text-amber-700">{COMPLETENESS_LABELS.PARTIAL}</p>
              )}
            </div>
          );
        })}
      </dl>

      {incomplete.length > 0 && (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Algún ingrediente no informa{" "}
          {incomplete.map((k) => NUTRIENT_LABELS[k].label.toLowerCase()).join(", ")}. Lo que se
          muestra es la suma de lo que sí se conoce, no el total del plato.
        </p>
      )}
    </section>
  );
}
