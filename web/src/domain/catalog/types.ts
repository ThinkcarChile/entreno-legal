/** Nutrientes soportados como columnas (extensibles vía extended_nutrients). */
export const NUTRIENT_KEYS = [
  "energy_kcal",
  "protein_g",
  "carbohydrates_g",
  "fat_g",
  "fiber_g",
  "sugars_g",
  "saturated_fat_g",
  "sodium_mg",
  "potassium_mg",
  "phosphorus_mg",
] as const;

export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

/**
 * Valores por 100 g / 100 ml. Regla crítica (ADR 0001 §4): UNKNOWN != ZERO —
 * un nutriente no informado es `null`, jamás 0.
 */
export type NutritionValues = Partial<Record<NutrientKey, number | null>>;

export type BasisUnit = "G" | "ML";

export type WeightBasis = "RAW" | "COOKED" | "DRAINED" | "EDIBLE_PORTION" | "AS_PACKAGED";

export type SourceType =
  | "PACKAGE_LABEL_VERIFIED"
  | "NATIONAL_FOOD_DATABASE"
  | "USDA_FOODDATA_CENTRAL"
  | "OTHER_VERIFIED_DATABASE"
  | "USER_ENTERED_LABEL"
  | "USER_ENTERED_GENERIC"
  | "AI_ESTIMATE"
  | "DEV_SEED";

/**
 * Vector nutricional ya **dimensionalmente resuelto**: nutrientes absolutos
 * (kcal, g, mg) para una cantidad concreta. A diferencia de `NutritionFact`,
 * NO arrastra base (RAW/COOKED, g/ml): esa dimensión ya se consumió al calcular.
 * Por eso dos vectores absolutos siempre se pueden sumar aunque provengan de
 * ingredientes con estados distintos (ADR 0002 §2).
 */
export type AbsoluteNutrients = NutritionValues;

/**
 * Completitud por nutriente de una suma (Sprint 3 §21). UNKNOWN != ZERO, y
 * además "sumé todos" != "sumé los que sabía".
 */
export type NutrientCompleteness = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export type NutritionCompleteness = Record<NutrientKey, NutrientCompleteness>;

/** Resultado de agregar vectores absolutos: valores + qué tan confiable es cada uno. */
export interface AggregatedNutrition {
  /** Suma de los aportes CONOCIDOS. `null` si ninguno lo conocía. */
  values: NutritionValues;
  completeness: NutritionCompleteness;
  /** Cuántos vectores participaron en la suma. */
  contributors: number;
}

export const COMPLETENESS_LABELS: Record<NutrientCompleteness, string> = {
  COMPLETE: "Cálculo completo",
  PARTIAL: "Cálculo incompleto",
  UNKNOWN: "Sin datos",
};

/** Conjunto nutricional con identidad de base (estado + unidad). */
export interface NutritionFact {
  values: NutritionValues;
  weightBasis: WeightBasis;
  basisUnit: BasisUnit;
}

export const NUTRIENT_LABELS: Record<NutrientKey, { label: string; unit: string }> = {
  energy_kcal: { label: "Energía", unit: "kcal" },
  protein_g: { label: "Proteína", unit: "g" },
  carbohydrates_g: { label: "Carbohidratos", unit: "g" },
  fat_g: { label: "Grasas", unit: "g" },
  fiber_g: { label: "Fibra", unit: "g" },
  sugars_g: { label: "Azúcares", unit: "g" },
  saturated_fat_g: { label: "Grasas saturadas", unit: "g" },
  sodium_mg: { label: "Sodio", unit: "mg" },
  potassium_mg: { label: "Potasio", unit: "mg" },
  phosphorus_mg: { label: "Fósforo", unit: "mg" },
};

export const WEIGHT_BASIS_LABELS: Record<WeightBasis, string> = {
  RAW: "Crudo",
  COOKED: "Cocido",
  DRAINED: "Escurrido",
  EDIBLE_PORTION: "Porción comestible",
  AS_PACKAGED: "Como se vende",
};

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  PACKAGE_LABEL_VERIFIED: "Etiqueta verificada",
  NATIONAL_FOOD_DATABASE: "Base nacional de alimentos",
  USDA_FOODDATA_CENTRAL: "USDA FoodData Central",
  OTHER_VERIFIED_DATABASE: "Base verificada",
  USER_ENTERED_LABEL: "Etiqueta ingresada por usuario",
  USER_ENTERED_GENERIC: "Estimación de usuario",
  AI_ESTIMATE: "Estimación de IA (no verificada)",
  DEV_SEED: "Datos de desarrollo (no oficiales)",
};
