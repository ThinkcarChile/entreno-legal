import {
  COMPLETENESS_LABELS,
  NUTRIENT_KEYS,
  NUTRIENT_LABELS,
  type AggregatedNutrition,
} from "@/domain/catalog/types";
import { roundForDisplay } from "@/domain/catalog/nutrition";
import { Card, Icon, Notice } from "@/components/ui";

/**
 * Muestra una agregación nutricional sin mentir: un valor PARCIAL nunca se
 * presenta como si fuera el total, y un desconocido nunca se muestra como 0
 * (ADR 0002 §5).
 *
 * Por eso el "≥" y el "Sin datos" viajan como TEXTO y no como un color: quien
 * no distingue el matiz igual tiene que enterarse de que el número está
 * incompleto.
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
    <Card as="section" className="p-md">
      <div className="mb-md flex items-center gap-sm">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-fixed text-on-primary-fixed">
          <Icon name="nutrition" filled />
        </span>
        <h3 className="min-w-0 font-headline-sm text-headline-sm text-on-surface">{title}</h3>
      </div>

      <dl className="grid grid-cols-2 gap-x-md gap-y-md sm:grid-cols-3">
        {keys.map((key) => {
          const state = nutrition.completeness[key];
          const value = nutrition.values[key];
          const rounded = roundForDisplay(value, key === "energy_kcal" ? 0 : 1);
          return (
            <div key={key} className="min-w-0">
              <dt className="font-label-md text-label-md text-on-surface-variant">
                {NUTRIENT_LABELS[key].label}
              </dt>
              <dd className="font-body-md text-body-md font-semibold tabular-nums text-on-surface">
                {state === "UNKNOWN" || rounded === null ? (
                  <span className="font-normal text-outline">Sin datos</span>
                ) : (
                  <>
                    {state === "PARTIAL" && <span aria-hidden>≥ </span>}
                    {rounded.toLocaleString("es-CL")}{" "}
                    <span className="font-body-sm text-body-sm font-normal text-on-surface-variant">
                      {NUTRIENT_LABELS[key].unit}
                    </span>
                  </>
                )}
              </dd>
              {state === "PARTIAL" && (
                <p className="font-label-md text-label-md text-on-secondary-fixed-variant">
                  {COMPLETENESS_LABELS.PARTIAL}
                </p>
              )}
            </div>
          );
        })}
      </dl>

      {incomplete.length > 0 && (
        <div className="mt-md">
          <Notice icon="rule">
            Algún ingrediente no informa{" "}
            {incomplete.map((k) => NUTRIENT_LABELS[k].label.toLowerCase()).join(", ")}. Lo que se
            muestra es la suma de lo que sí se conoce, no el total del plato.
          </Notice>
        </div>
      )}
    </Card>
  );
}
