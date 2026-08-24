import { calculateMealNutrition, type MealNutrition } from "./nutrition";
import type { RecipeComponent } from "./types";

/**
 * Escalado de una versión (§8). Es una PROYECCIÓN pura: no toca la receta
 * persistida, no redondea internamente y devuelve la nutrición recalculada.
 */

export interface ScaledComponent extends RecipeComponent {
  /** Cantidad original de la receta base, para poder mostrar el antes/después. */
  baseQuantity: number;
}

export interface ScaledVersion {
  baseServings: number;
  requestedServings: number;
  factor: number;
  components: ScaledComponent[];
  nutrition: MealNutrition;
}

export function scaleMealTemplateVersion(
  version: { baseServings: number; components: readonly RecipeComponent[] },
  requestedServings: number,
): ScaledVersion {
  if (!Number.isFinite(requestedServings) || requestedServings <= 0) {
    throw new Error("Las porciones solicitadas deben ser mayores que 0");
  }
  if (!Number.isInteger(version.baseServings) || version.baseServings <= 0) {
    throw new Error("Las porciones base deben ser un entero mayor que 0");
  }

  const factor = requestedServings / version.baseServings;
  const components: ScaledComponent[] = version.components.map((component) => ({
    ...component,
    baseQuantity: component.quantity,
    quantity: component.quantity * factor,
  }));

  return {
    baseServings: version.baseServings,
    requestedServings,
    factor,
    components,
    // La nutrición escalada se recalcula desde las cantidades escaladas: nunca
    // se multiplica un total ya agregado (eso perdería la completitud real).
    nutrition: calculateMealNutrition(components, requestedServings),
  };
}

/**
 * Redondeo de cantidades SOLO para mostrar (§9). Nunca alimenta el cálculo
 * nutricional: 1.079,9999999 g se muestra como 1.080 g, pero los nutrientes
 * salen del valor exacto.
 */
export function roundQuantityForDisplay(quantity: number): number {
  if (!Number.isFinite(quantity)) return quantity;
  const abs = Math.abs(quantity);
  if (abs >= 100) return Math.round(quantity);
  if (abs >= 10) return Math.round(quantity * 10) / 10;
  return Math.round(quantity * 100) / 100;
}
