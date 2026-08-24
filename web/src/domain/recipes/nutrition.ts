import {
  calculateNutritionForQuantity,
  divideAggregated,
  sumAbsoluteNutrients,
} from "../catalog/nutrition";
import { NUTRIENT_KEYS, type AbsoluteNutrients, type AggregatedNutrition } from "../catalog/types";
import type { RecipeComponent } from "./types";

/**
 * Nutrición de una receta (§20).
 *
 * El orden importa y es lo que hace válida una receta con estados mezclados:
 *   1. cada componente se resuelve con SU ficha nutricional congelada;
 *   2. se calcula su vector para SU cantidad, en SU base;
 *   3. el resultado ya no arrastra RAW/COOKED ni g/ml — es absoluto;
 *   4. recién ahí se suman los vectores.
 *
 * Por eso pollo 220 g RAW + arroz 150 g COOKED + tomate 200 g RAW se calcula
 * sin problema, mientras que interpretar una ficha RAW como si fuera COOKED
 * sigue siendo un error (ADR 0002).
 */

const UNKNOWN_VECTOR: AbsoluteNutrients = Object.fromEntries(
  NUTRIENT_KEYS.map((key) => [key, null]),
) as AbsoluteNutrients;

/** Resuelve un componente a nutrientes absolutos para su cantidad. */
export function resolveComponentNutrition(component: RecipeComponent): AbsoluteNutrients {
  const fact = component.nutrition;
  // Sin ficha no se inventa: aporta desconocido en todo (UNKNOWN != ZERO).
  if (!fact) return { ...UNKNOWN_VECTOR };

  if (fact.weightBasis !== component.weightBasis) {
    throw new Error(
      `"${component.label}": la cantidad está en base ${component.weightBasis} pero la ficha ` +
        `nutricional es ${fact.weightBasis}. Usar la ficha equivocada falsea el cálculo.`,
    );
  }
  return calculateNutritionForQuantity(fact.values, component.quantity, component.unit, fact.basisUnit);
}

export interface MealNutrition {
  /** Nutrición de la receta completa, para sus porciones base. */
  total: AggregatedNutrition;
  /** Total dividido por las porciones base. */
  perServing: AggregatedNutrition;
  baseServings: number;
  /** Componentes que participaron (los opcionales pueden excluirse). */
  componentCount: number;
}

export interface MealNutritionOptions {
  /** Los opcionales (aceite, aderezo) SÍ aportan kcal: por defecto se incluyen (§12). */
  includeOptional?: boolean;
}

export function calculateMealNutrition(
  components: readonly RecipeComponent[],
  baseServings: number,
  options: MealNutritionOptions = {},
): MealNutrition {
  if (!Number.isInteger(baseServings) || baseServings <= 0) {
    throw new Error("Las porciones base deben ser un entero mayor que 0");
  }
  const includeOptional = options.includeOptional ?? true;
  const used = includeOptional ? components : components.filter((c) => !c.isOptional);

  const vectors = used.map(resolveComponentNutrition);
  const total = sumAbsoluteNutrients(vectors);

  return {
    total,
    perServing: divideAggregated(total, baseServings),
    baseServings,
    componentCount: used.length,
  };
}
