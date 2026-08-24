import type { MealType } from "../recipes/types";

/**
 * Perfil nutricional de un integrante: tracking, objetivos con rango, patrón de
 * comidas y preferencias. Es lo que el PortionOptimizer consulta — nunca las
 * tablas sueltas (Baseline §E-1, K-3).
 */

/** K-25: nivel, no booleano. */
export const TRACKING_MODES = ["OFF", "BASIC", "FULL"] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

export const GOAL_TYPES = [
  "ENERGY_KCAL",
  "PROTEIN_G",
  "CARBOHYDRATE_G",
  "FAT_G",
  "FIBER_G",
] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

/**
 * Un objetivo NO es un número: es un rango, y cualquiera de sus tres bordes
 * puede faltar. "mínimo 120, ideal 130, sin máximo" es tan válido como
 * "50 / 65 / 80" (§5).
 */
export interface GoalRange {
  minimum: number | null;
  preferred: number | null;
  maximum: number | null;
}

export type TargetSet = Partial<Record<GoalType, GoalRange>>;

export const MEAL_AVAILABILITIES = ["ENABLED", "DISABLED", "OPTIONAL"] as const;
export type MealAvailability = (typeof MEAL_AVAILABILITIES)[number];

export const SALAD_PREFERENCES = ["PREFERRED", "NEUTRAL", "AVOID"] as const;
export type SaladPreference = (typeof SALAD_PREFERENCES)[number];

export interface MealPatternSlot {
  mealType: MealType;
  availability: MealAvailability;
  isFirstMeal: boolean;
  saladPreference: SaladPreference;
  priority: number;
}

export interface MealPattern {
  usesFastingPattern: boolean;
  firstMealType: MealType | null;
  feedingWindowStart: string | null;
  feedingWindowEnd: string | null;
  meals: MealPatternSlot[];
}

/**
 * HARD vs SOFT (§12). Las HARD son de seguridad y el optimizador nunca las
 * viola; las SOFT penalizan, explican y como mucho proponen un reemplazo.
 */
export const HARD_PREFERENCES = ["ALLERGY", "INTOLERANCE", "MEDICAL_RESTRICTION"] as const;
export const SOFT_PREFERENCES = ["FAVORITE", "LIKE", "NEUTRAL", "DISLIKE", "AVOID"] as const;
export const PREFERENCE_TYPES = [...SOFT_PREFERENCES, ...HARD_PREFERENCES] as const;
export type PreferenceType = (typeof PREFERENCE_TYPES)[number];

export function isHardPreference(type: PreferenceType): boolean {
  return (HARD_PREFERENCES as readonly string[]).includes(type);
}

export type PreferenceTargetKind = "INGREDIENT" | "CATEGORY" | "MEAL_TEMPLATE" | "PRODUCT";

export interface MemberPreference {
  preferenceType: PreferenceType;
  targetKind: PreferenceTargetKind;
  targetId: string;
  label?: string;
}

export const COOKING_STANCES = ["PREFERRED", "ACCEPTED", "AVOID"] as const;
export type CookingStance = (typeof COOKING_STANCES)[number];

export interface CookingPreference {
  /** Prioridad de resolución: ingrediente > categoría > global (§14). */
  ingredientId: string | null;
  categoryId: string | null;
  cookingMethod: string;
  stance: CookingStance;
}

export const ADDED_FAT_STANCES = ["AVOID", "ALLOWED", "PREFERRED"] as const;
export type AddedFatStance = (typeof ADDED_FAT_STANCES)[number];

/** Snapshot inmutable y versionado (§16). Todo el cálculo mira solo esto. */
export interface MemberNutritionProfile {
  memberId: string;
  memberName: string;
  profileId: string | null;
  version: number;
  trackingMode: TrackingMode;
  dailyTargets: TargetSet;
  mealTargets: Partial<Record<MealType, TargetSet>>;
  pattern: MealPattern;
  preferences: MemberPreference[];
  cookingPreferences: CookingPreference[];
  addedFatStance: AddedFatStance;
  /** Huella de las entradas: mismas entradas ⇒ mismo perfil, no se versiona en vano. */
  inputSignature: string;
}

export const TRACKING_LABELS: Record<TrackingMode, string> = {
  OFF: "Sin seguimiento",
  BASIC: "Seguimiento básico",
  FULL: "Seguimiento completo",
};

export const TRACKING_DESCRIPTIONS: Record<TrackingMode, string> = {
  OFF: "Participa de las recetas, las porciones y la planificación, pero no se le pide ni se le muestra conteo de calorías.",
  BASIC: "Algunos objetivos (peso, proteína, patrón de comidas) sin exigir registro detallado.",
  FULL: "Calorías y macros, objetivos por comida y seguimiento del progreso.",
};

export const GOAL_LABELS: Record<GoalType, { label: string; unit: string }> = {
  ENERGY_KCAL: { label: "Energía", unit: "kcal" },
  PROTEIN_G: { label: "Proteína", unit: "g" },
  CARBOHYDRATE_G: { label: "Carbohidratos", unit: "g" },
  FAT_G: { label: "Grasas", unit: "g" },
  FIBER_G: { label: "Fibra", unit: "g" },
};

export const PREFERENCE_LABELS: Record<PreferenceType, string> = {
  FAVORITE: "Favorito",
  LIKE: "Le gusta",
  NEUTRAL: "Neutral",
  DISLIKE: "No le gusta",
  AVOID: "Prefiere evitar",
  INTOLERANCE: "Intolerancia",
  ALLERGY: "Alergia",
  MEDICAL_RESTRICTION: "Restricción médica",
};

export const ADDED_FAT_LABELS: Record<AddedFatStance, string> = {
  AVOID: "Evita la grasa añadida",
  ALLOWED: "Acepta grasa añadida",
  PREFERRED: "Prefiere con grasa añadida",
};

export const SALAD_PREFERENCE_LABELS: Record<SaladPreference, string> = {
  PREFERRED: "Prefiere ensalada",
  NEUTRAL: "Indiferente",
  AVOID: "Prefiere evitarla",
};
