import type { MealType } from "../recipes/types";
import type {
  GoalRange,
  GoalType,
  MealPattern,
  MemberNutritionProfile,
  MemberPreference,
  CookingPreference,
  AddedFatStance,
  TargetSet,
  TrackingMode,
} from "./types";

/**
 * Construcción del snapshot de perfil (§16) y resolución de objetivos efectivos.
 *
 * Todo acá es puro y determinista: las mismas entradas producen la misma huella
 * y, por lo tanto, el mismo perfil. Eso es lo que permite el recálculo selectivo
 * (§17): si la huella no cambió, no se versiona nada.
 */

export interface ProfileInputs {
  memberId: string;
  memberName: string;
  trackingMode: TrackingMode;
  /** Objetivos vigentes, ya filtrados por status ACTIVE y vigencia. */
  goals: {
    goalType: GoalType;
    scope: "DAILY" | "PER_MEAL";
    mealType: MealType | null;
    minimum: number | null;
    preferred: number | null;
    maximum: number | null;
    priority: number;
  }[];
  pattern: MealPattern;
  preferences: MemberPreference[];
  cookingPreferences: CookingPreference[];
  addedFatStance: AddedFatStance;
}

/** Hash FNV-1a de 32 bits: determinista, sin dependencias, suficiente para una huella. */
export function signature(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** JSON con claves ordenadas: el orden de las filas no puede cambiar la huella. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function buildProfile(inputs: ProfileInputs): MemberNutritionProfile {
  const dailyTargets: TargetSet = {};
  const mealTargets: Partial<Record<MealType, TargetSet>> = {};

  // Orden determinista: dos consultas con el mismo contenido en distinto orden
  // deben producir exactamente la misma huella.
  const goals = [...inputs.goals].sort((a, b) => {
    const key = (g: (typeof inputs.goals)[number]) =>
      `${g.scope}|${g.mealType ?? ""}|${g.goalType}|${g.priority}`;
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  });

  for (const goal of goals) {
    const range: GoalRange = {
      minimum: goal.minimum,
      preferred: goal.preferred,
      maximum: goal.maximum,
    };
    if (goal.scope === "DAILY") {
      dailyTargets[goal.goalType] = range;
    } else if (goal.mealType) {
      mealTargets[goal.mealType] = { ...(mealTargets[goal.mealType] ?? {}), [goal.goalType]: range };
    }
  }

  const inputSignature = signature({
    trackingMode: inputs.trackingMode,
    goals,
    pattern: inputs.pattern,
    preferences: [...inputs.preferences].sort((a, b) => (a.targetId < b.targetId ? -1 : 1)),
    cookingPreferences: [...inputs.cookingPreferences].sort((a, b) =>
      `${a.ingredientId}${a.categoryId}${a.cookingMethod}` <
      `${b.ingredientId}${b.categoryId}${b.cookingMethod}`
        ? -1
        : 1,
    ),
    addedFatStance: inputs.addedFatStance,
  });

  return {
    memberId: inputs.memberId,
    memberName: inputs.memberName,
    profileId: null,
    version: 0,
    trackingMode: inputs.trackingMode,
    dailyTargets,
    mealTargets,
    pattern: inputs.pattern,
    preferences: inputs.preferences,
    cookingPreferences: inputs.cookingPreferences,
    addedFatStance: inputs.addedFatStance,
    inputSignature,
  };
}

/** ¿Esta persona hace esta comida? Desayuno desactivado ⇒ no se le reserva nada (§8). */
export function mealIsEnabled(profile: MemberNutritionProfile, mealType: MealType): boolean {
  const slot = profile.pattern.meals.find((m) => m.mealType === mealType);
  if (!slot) return true; // sin patrón configurado, la comida existe
  return slot.availability !== "DISABLED";
}

export function firstMeal(profile: MemberNutritionProfile): MealType | null {
  const marked = profile.pattern.meals.find((m) => m.isFirstMeal && m.availability !== "DISABLED");
  if (marked) return marked.mealType;
  return profile.pattern.firstMealType;
}

/**
 * Objetivos efectivos de una comida: la excepción del día manda sobre el patrón
 * habitual, y no lo modifica (§19).
 */
export function effectiveMealTargets(
  profile: MemberNutritionProfile,
  mealType: MealType,
  override?: TargetSet | null,
): TargetSet {
  if (!mealIsEnabled(profile, mealType)) return {};
  const base = profile.mealTargets[mealType] ?? {};
  if (!override) return base;
  return { ...base, ...override };
}

export function hasAnyTarget(targets: TargetSet): boolean {
  return Object.values(targets).some(
    (range) => range && (range.minimum !== null || range.preferred !== null || range.maximum !== null),
  );
}

/**
 * Una persona con tracking OFF nunca debe ver "te quedan 0 kcal" (§10): no es
 * que su presupuesto sea cero, es que no tiene presupuesto.
 */
export function countsCalories(profile: MemberNutritionProfile): boolean {
  return profile.trackingMode === "FULL";
}
