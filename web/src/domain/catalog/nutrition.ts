import { NUTRIENT_KEYS, type BasisUnit, type NutritionFact, type NutritionValues } from "./types";

/**
 * Cálculo nutricional puro (ADR 0001 §7):
 * - sin redondeo interno (la UI redondea solo para mostrar);
 * - null se propaga: UNKNOWN != ZERO, un nutriente desconocido nunca se convierte en 0.
 */

/** Escala valores por-100 a una cantidad consumida (en la misma unidad base). */
export function calculateNutritionForQuantity(
  per100: NutritionValues,
  quantity: number,
  unit: BasisUnit,
  basisUnit: BasisUnit,
): NutritionValues {
  if (unit !== basisUnit) {
    throw new Error(
      `Unidad incompatible: la nutrición está por 100 ${basisUnit} y la cantidad viene en ${unit}. ` +
        "Convierta con una equivalencia explícita antes de calcular.",
    );
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error("Cantidad inválida");
  }
  const factor = quantity / 100;
  const result: NutritionValues = {};
  for (const key of NUTRIENT_KEYS) {
    const value = per100[key];
    result[key] = value === null || value === undefined ? null : value * factor;
  }
  return result;
}

export interface LabelInput {
  servingQuantity: number;
  servingUnit: BasisUnit;
  values: NutritionValues; // valores POR PORCIÓN tal como aparecen en la etiqueta
}

export interface NormalizedLabel {
  per100: NutritionValues;
  basisUnit: BasisUnit;
  /** El dato original nunca se pierde (ADR 0001 §3). */
  original: LabelInput;
}

/** Normaliza una etiqueta por porción (48 g = 90 kcal) a base por 100. */
export function normalizeLabelToPer100(label: LabelInput): NormalizedLabel {
  if (!Number.isFinite(label.servingQuantity) || label.servingQuantity <= 0) {
    throw new Error("La porción debe ser mayor que 0");
  }
  const factor = 100 / label.servingQuantity;
  const per100: NutritionValues = {};
  for (const key of NUTRIENT_KEYS) {
    const value = label.values[key];
    per100[key] = value === null || value === undefined ? null : value * factor;
  }
  return { per100, basisUnit: label.servingUnit, original: label };
}

/**
 * "Comí 2 porciones": convierte porciones a cantidad base. Si el usuario aporta
 * el peso real (2 rebanadas = 73 g), el peso real tiene prioridad.
 */
export function quantityFromServings(
  servings: number,
  servingQuantity: number,
  actualWeight?: number | null,
): number {
  if (actualWeight !== undefined && actualWeight !== null) {
    if (!Number.isFinite(actualWeight) || actualWeight <= 0) {
      throw new Error("Peso real inválido");
    }
    return actualWeight;
  }
  if (!Number.isFinite(servings) || servings <= 0) throw new Error("Porciones inválidas");
  if (!Number.isFinite(servingQuantity) || servingQuantity <= 0) {
    throw new Error("Porción sin peso definido");
  }
  return servings * servingQuantity;
}

/**
 * Suma conjuntos nutricionales YA escalados a cantidades absolutas.
 * Rechaza mezclar bases distintas (crudo vs cocido, g vs ml): 100 g de arroz
 * crudo no es comparable con 100 g cocido.
 * NULL se propaga: si un componente desconoce un nutriente, la suma es desconocida.
 */
export function combineNutrition(facts: readonly NutritionFact[]): NutritionFact {
  if (facts.length === 0) throw new Error("Nada que combinar");
  const first = facts[0]!;
  for (const fact of facts) {
    if (fact.weightBasis !== first.weightBasis || fact.basisUnit !== first.basisUnit) {
      throw new Error(
        `No se pueden combinar bases distintas: ${first.weightBasis}/${first.basisUnit} vs ${fact.weightBasis}/${fact.basisUnit}`,
      );
    }
  }
  const values: NutritionValues = {};
  for (const key of NUTRIENT_KEYS) {
    let sum: number | null = 0;
    for (const fact of facts) {
      const value = fact.values[key];
      if (value === null || value === undefined) {
        sum = null;
        break;
      }
      sum += value;
    }
    values[key] = sum;
  }
  return { values, weightBasis: first.weightBasis, basisUnit: first.basisUnit };
}

/** Redondeo SOLO para visualización/persistencia (half-up, n decimales). */
export function roundForDisplay(value: number | null | undefined, decimals = 1): number | null {
  if (value === null || value === undefined) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
