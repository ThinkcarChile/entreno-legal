import {
  NUTRIENT_KEYS,
  type AbsoluteNutrients,
  type AggregatedNutrition,
  type BasisUnit,
  type NutrientCompleteness,
  type NutritionCompleteness,
  type NutritionFact,
  type NutritionValues,
} from "./types";

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
 * Combina fichas que comparten UNA MISMA REPRESENTACIÓN (misma base y unidad),
 * p. ej. dos mediciones por-100 g RAW del mismo alimento. Rechaza fusionar
 * representaciones incompatibles: 100 g de arroz crudo no es 100 g de cocido.
 *
 * OJO — esto NO es lo que usa una receta. Una receta con pollo RAW y arroz
 * COOKED es perfectamente válida: cada ingrediente se resuelve con SU ficha,
 * se convierte a nutrientes absolutos y recién ahí se suma. Para eso está
 * {@link sumAbsoluteNutrients}, no esta función (ADR 0002 §2).
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

/**
 * Suma vectores **absolutos** (ya dimensionalmente resueltos: kcal, g, mg para
 * cantidades concretas). Aquí la base RAW/COOKED y la unidad g/ml ya se
 * consumieron al calcular cada vector, así que sumar pollo crudo con arroz
 * cocido es legítimo — es lo que hace cualquier receta real.
 *
 * Reporta completitud por nutriente (Sprint 3 §21), porque "sumé los 5 aportes"
 * no es lo mismo que "sumé los 3 que conocía":
 * - COMPLETE: todos los aportes traían el nutriente;
 * - PARTIAL:  algunos sí y otros no → el valor es una suma parcial, jamás se
 *             presenta como total (la UI muestra "cálculo incompleto");
 * - UNKNOWN:  ninguno lo traía → valor `null`, nunca 0.
 */
export function sumAbsoluteNutrients(
  vectors: readonly AbsoluteNutrients[],
): AggregatedNutrition {
  const completeness = {} as NutritionCompleteness;
  const values: NutritionValues = {};

  for (const key of NUTRIENT_KEYS) {
    let sum = 0;
    let known = 0;
    for (const vector of vectors) {
      const value = vector[key];
      if (value === null || value === undefined) continue;
      sum += value;
      known += 1;
    }
    let state: NutrientCompleteness;
    if (known === 0) state = "UNKNOWN";
    else if (known === vectors.length) state = "COMPLETE";
    else state = "PARTIAL";

    completeness[key] = state;
    values[key] = state === "UNKNOWN" ? null : sum;
  }

  return { values, completeness, contributors: vectors.length };
}

/** Divide una agregación por un número de porciones, conservando la completitud. */
export function divideAggregated(
  aggregated: AggregatedNutrition,
  servings: number,
): AggregatedNutrition {
  if (!Number.isFinite(servings) || servings <= 0) {
    throw new Error("Las porciones deben ser mayores que 0");
  }
  const values: NutritionValues = {};
  for (const key of NUTRIENT_KEYS) {
    const value = aggregated.values[key];
    values[key] = value === null || value === undefined ? null : value / servings;
  }
  return { values, completeness: aggregated.completeness, contributors: aggregated.contributors };
}

/** Redondeo SOLO para visualización/persistencia (half-up, n decimales). */
export function roundForDisplay(value: number | null | undefined, decimals = 1): number | null {
  if (value === null || value === undefined) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
