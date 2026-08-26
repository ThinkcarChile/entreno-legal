import { calculateNutritionForQuantity, divideAggregated, sumAbsoluteNutrients } from "../catalog/nutrition";
import { NUTRIENT_KEYS, type NutrientKey, type AggregatedNutrition, type BasisUnit, type NutritionFact, type WeightBasis } from "../catalog/types";
import { effectiveMealTargets, hasAnyTarget, mealIsEnabled } from "../nutrition/profile";
import type { MemberNutritionProfile, TargetSet } from "../nutrition/types";
import { isHardPreference } from "../nutrition/types";
import type { CookingMethod, MealType, SlotType } from "../recipes/types";
import { COOKING_METHOD_LABELS, MEAL_TYPE_LABELS } from "../recipes/types";
import { reason, type Reason } from "./reasons";

/**
 * PortionOptimizer (§22, §23) — determinista y sin IA (§47).
 *
 * Busca la porción de MÍNIMA adaptación: primero se prueba la estándar, después
 * se cambian cantidades, después el método de cocción. Nunca hace cambios
 * aleatorios y, cuando el objetivo es imposible, dice que es imposible en vez de
 * inventar un número (§27).
 */

export const OPTIMIZER_VERSION = "portion-optimizer/1.0.0";

export type SlotAdjustability = "FIXED" | "ADJUSTABLE" | "OPTIONAL";

/** MAIN = comida. ADDED_FAT = grasa de preparación. SEASONING = aliño sin peso nutricional relevante. */
export type ComponentRole = "MAIN" | "ADDED_FAT" | "SEASONING";

export interface PortionComponent {
  id: string;
  /** Slot al que pertenece: las alternativas culinarias se declaran por slot. */
  slotId: string;
  label: string;
  slotType: SlotType;
  /** Cantidad de la receta TOTAL, para `baseServings` personas. */
  quantity: number;
  unit: BasisUnit;
  weightBasis: WeightBasis;
  nutrition: NutritionFact | null;
  cookingMethod: CookingMethod | null;
  adjustability: SlotAdjustability;
  /** Rol culinario declarado por la receta (ADR 0004). */
  role: ComponentRole;
  /** Límites de la receta, también en cantidad total. `null` = sin definir (§29). */
  minQuantity: number | null;
  maxQuantity: number | null;
  ingredientId: string | null;
  /** Producto comercial, cuando el componente apunta a uno (§11 del Sprint 6). */
  productId: string | null;
  categoryId: string | null;
  isOptional: boolean;
}

export interface ServingComponent extends PortionComponent {
  /** Cantidad estándar por persona (base ÷ porciones). */
  baseQuantity: number;
  proposedQuantity: number;
  /** Grasa añadida por la preparación de ESTA persona (§35). */
  addedFatG: number;
  changed: boolean;
}

export const PERSONAL_MEAL_FITS = [
  "COMPATIBLE",
  "COMPATIBLE_WITH_PORTION_CHANGE",
  "COMPATIBLE_WITH_COOKING_CHANGE",
  "COMPATIBLE_WITH_ONE_SUBSTITUTION",
  "TARGET_CONFLICT",
  "NOT_COMPATIBLE",
] as const;
export type PersonalMealFit = (typeof PERSONAL_MEAL_FITS)[number];

export interface MemberServingProjection {
  memberId: string;
  memberName: string;
  /** Versión EXACTA de la receta con la que se calculó (§46). */
  versionId: string;
  mealType: MealType;
  fit: PersonalMealFit;
  /** 0 estándar · 1 cantidades · 2 cocción · 3 sustitución · 4 revisión. */
  adaptationLevel: number;
  components: ServingComponent[];
  nutrition: AggregatedNutrition;
  targets: TargetSet;
  metConstraints: string[];
  unmetConstraints: string[];
  /**
   * Límites que NO se pudieron verificar porque la ficha del plato está
   * incompleta. No son "cumplidos" ni "incumplidos": son desconocidos, y la
   * pantalla los muestra como tales.
   */
  unverifiableConstraints: string[];
  reasons: Reason[];
  /** Reemplazos propuestos, NO aplicados. La persona decide (§37). */
  suggestions: SubstitutionSuggestion[];
  score: number;
  optimizerVersion: string;
  profileVersion: number;
}

/** Alternativa culinaria disponible para un slot (viene de la receta). */
export interface AvailableAlternative {
  slotId: string;
  ingredientId: string;
  label: string;
  nutrition: NutritionFact | null;
}

/**
 * Reemplazo ACEPTADO por la persona (§37). Nunca se aplica solo: el motor
 * sugiere, alguien decide, y recién ahí se vuelve a optimizar sobre el plato
 * cambiado.
 */
export interface AcceptedSubstitution {
  componentId: string;
  ingredientId: string;
  label: string;
  nutrition: NutritionFact | null;
}

export interface SubstitutionSuggestion {
  componentId: string;
  componentLabel: string;
  ingredientId: string;
  alternativeLabel: string;
  reason: string;
}

/**
 * Techo clínico CONFIRMADO por el ClinicalRulesEngine (§31).
 *
 * Vive acá —y no en el dominio clínico— porque es lo ÚNICO clínico que el
 * optimizador entiende: un número y de qué restricción salió. Ni el
 * biomarcador, ni el diagnóstico, ni el texto de la regla cruzan esta puerta.
 */
export interface ClinicalCeiling {
  nutrient: NutrientKey;
  max: number;
  /** De qué restricción salió: para poder citarla en el conflicto (§74). */
  restrictionId: string;
}

export interface OptimizeInput {
  versionId: string;
  components: readonly PortionComponent[];
  /** Alternativas que la receta declara para cada slot. */
  alternatives?: readonly AvailableAlternative[];
  /** Reemplazos ya aceptados por la persona. */
  substitutions?: readonly AcceptedSubstitution[];
  baseServings: number;
  profile: MemberNutritionProfile;
  mealType: MealType;
  /** Excepción del día: manda sobre el patrón, sin modificarlo (§19). */
  override?: TargetSet | null;
  /**
   * Objetivos ya resueltos por quien llama, que REEMPLAZAN a los del patrón en
   * vez de mezclarse con ellos.
   *
   * Existe por los eventos (§5): "sin conteo ese día" tiene que dejar la comida
   * SIN objetivos, y un `override` vacío no puede expresar eso — mezclar `{}`
   * sobre el patrón devuelve el patrón intacto. La diferencia entre "no cambio
   * nada" y "hoy no hay objetivos" no se puede escribir con un solo campo.
   */
  resolvedTargets?: TargetSet | null;
  /**
   * Sprint 11 §31: techos CONFIRMADOS que el ClinicalRulesEngine entrega
   * (`proposedAdjustments`, kind NUTRIENT_CEILING). Solo llegan acá límites
   * válidos, confirmados y en la unidad del catálogo — el motor clínico ya
   * filtró todo lo demás. AI NEVER OVERRIDES CLINICAL RULES: estos techos no
   * se negocian; si no se pueden cumplir el resultado es TARGET_CONFLICT con
   * razón clínica, jamás una porción diminuta presentada como correcta (§32).
   */
  clinicalCeilings?: readonly ClinicalCeiling[];
}

/** Márgenes conservadores cuando la receta no define límites (§29). */
const CONSERVATIVE_MIN_FACTOR = 0.5;
const CONSERVATIVE_MAX_FACTOR = 2;

/**
 * Orden en que se recorta para bajar calorías (§26). La ensalada y las verduras
 * van al final a propósito: no se le quita la ensalada a alguien para cuadrar
 * un número.
 */
const REDUCTION_ORDER: SlotType[] = [
  "FAT",
  "SAUCE",
  "TOPPING",
  "SWEETENER",
  "CARBOHYDRATE",
  "BASE",
  "OTHER",
  "OPTIONAL",
  "DESSERT_COMPONENT",
  "FRUIT",
  "PROTEIN",
  "VEGETABLE",
  "SALAD",
];

const PROTEIN_SLOTS: SlotType[] = ["PROTEIN"];
const GREEN_SLOTS: SlotType[] = ["SALAD", "VEGETABLE"];

function bounds(component: ServingComponent): { min: number; max: number; declared: boolean } {
  const declared = component.minQuantity !== null || component.maxQuantity !== null;
  if (component.adjustability === "FIXED") {
    return { min: component.baseQuantity, max: component.baseQuantity, declared: true };
  }
  const scale = component.baseQuantity / (component.quantity || 1);
  const min =
    component.minQuantity !== null
      ? component.minQuantity * scale
      : component.adjustability === "OPTIONAL"
        ? 0
        : component.baseQuantity * CONSERVATIVE_MIN_FACTOR;
  const max =
    component.maxQuantity !== null
      ? component.maxQuantity * scale
      : component.baseQuantity * CONSERVATIVE_MAX_FACTOR;
  return { min, max, declared };
}

function nutritionOf(components: readonly ServingComponent[]): AggregatedNutrition {
  // Un componente en 0 g no forma parte de la porción y se excluye del todo.
  // Contarlo como "aporta 0 de cada nutriente" sería mentir dos veces: diría que
  // conocemos nutrientes que nadie informó, y volvería PARCIAL un total que en
  // realidad es DESCONOCIDO.
  const presentes = components.filter((c) => c.proposedQuantity > 0 || c.addedFatG > 0);
  const vectors = presentes.map((component) => {
    const fact = component.nutrition;
    const base =
      fact && component.proposedQuantity > 0
        ? calculateNutritionForQuantity(
            fact.values,
            component.proposedQuantity,
            component.unit,
            fact.basisUnit,
          )
        : Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, null]));
    if (!component.addedFatG) return base;
    // La grasa añadida pertenece a la porción de esta persona (§35): se suma
    // como energía y grasa explícitas, sin estimar absorción (no hay dato).
    const withFat = { ...base } as Record<string, number | null>;
    withFat.energy_kcal = (withFat.energy_kcal ?? 0) + component.addedFatG * 9;
    withFat.fat_g = (withFat.fat_g ?? 0) + component.addedFatG;
    return withFat;
  });
  if (vectors.length === 0) {
    return sumAbsoluteNutrients([Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, null]))]);
  }
  return sumAbsoluteNutrients(vectors);
}

function value(nutrition: AggregatedNutrition, key: NutrientKey): number {
  const v = nutrition.values[key];
  return v === null || v === undefined ? 0 : v;
}

/** Preferencia de cocción efectiva: ingrediente > categoría > global (§14). */
function preferredMethod(
  profile: MemberNutritionProfile,
  component: PortionComponent,
): CookingMethod | null {
  const prefs = profile.cookingPreferences.filter((p) => p.stance === "PREFERRED");
  const byIngredient = prefs.find(
    (p) => component.ingredientId && p.ingredientId === component.ingredientId,
  );
  if (byIngredient) return byIngredient.cookingMethod as CookingMethod;
  const byCategory = prefs.find((p) => component.categoryId && p.categoryId === component.categoryId);
  if (byCategory) return byCategory.cookingMethod as CookingMethod;
  const global = prefs.find((p) => !p.ingredientId && !p.categoryId);
  return global ? (global.cookingMethod as CookingMethod) : null;
}

function hardBlock(
  profile: MemberNutritionProfile,
  component: PortionComponent,
): { blocked: boolean; type?: string } {
  for (const pref of profile.preferences) {
    if (!isHardPreference(pref.preferenceType)) continue;
    if (pref.targetKind === "INGREDIENT" && pref.targetId === component.ingredientId) {
      return { blocked: true, type: pref.preferenceType };
    }
    if (pref.targetKind === "CATEGORY" && pref.targetId === component.categoryId) {
      return { blocked: true, type: pref.preferenceType };
    }
  }
  return { blocked: false };
}

function softDislike(profile: MemberNutritionProfile, component: PortionComponent): boolean {
  return profile.preferences.some(
    (p) =>
      (p.preferenceType === "DISLIKE" || p.preferenceType === "AVOID") &&
      ((p.targetKind === "INGREDIENT" && p.targetId === component.ingredientId) ||
        (p.targetKind === "CATEGORY" && p.targetId === component.categoryId)),
  );
}

/**
 * ¿Es grasa añadida? Lo dice la receta, no la composición del alimento.
 *
 * La versión anterior lo inferia: "slot FAT + opcional + más del 70 % de su
 * energía viene de la grasa". Medida contra casos reales borraba la palta
 * (82,7 %) y las semillas (78,6 %) del plato de quien evita la grasa añadida, y
 * el queso se salvaba por 0,7 puntos. Ningún umbral arregla eso: el rol
 * culinario de un ingrediente no se deduce de sus macros (ADR 0004).
 *
 * Además tiene que poder sacarse: una grasa que la receta declara obligatoria
 * no se quita por preferencia, se respeta la receta.
 */
function isAddedFat(component: ServingComponent): boolean {
  if (component.role !== "ADDED_FAT") return false;
  return component.adjustability === "OPTIONAL" || component.isOptional;
}

export function optimizePortion(input: OptimizeInput): MemberServingProjection {
  const { profile, mealType, baseServings } = input;
  if (!Number.isInteger(baseServings) || baseServings <= 0) {
    throw new Error("Las porciones base deben ser un entero mayor que 0");
  }

  const reasons: Reason[] = [];
  const metConstraints: string[] = [];
  const unmetConstraints: string[] = [];
  /** Límites que no se pueden dar por cumplidos porque falta la ficha (§J-1). */
  const unverifiableConstraints: string[] = [];
  const suggestions: SubstitutionSuggestion[] = [];

  const accepted = new Map((input.substitutions ?? []).map((s) => [s.componentId, s]));

  // Nivel 0: la porción estándar es siempre el punto de partida. Si hay un
  // reemplazo aceptado, se aplica ANTES de optimizar: el motor vuelve a correr
  // completo sobre el plato cambiado, no parcha el resultado anterior.
  const components: ServingComponent[] = input.components.map((component) => {
    const swap = accepted.get(component.id);
    const base = swap
      ? {
          ...component,
          label: swap.label,
          ingredientId: swap.ingredientId,
          nutrition: swap.nutrition,
        }
      : component;
    return {
      ...base,
      baseQuantity: base.quantity / baseServings,
      proposedQuantity: base.quantity / baseServings,
      addedFatG: 0,
      changed: false,
    };
  });

  for (const swap of accepted.values()) {
    const original = input.components.find((c) => c.id === swap.componentId);
    if (original) {
      reasons.push(
        reason("SUBSTITUTION_SUGGESTED", { component: original.label, alternative: swap.label }),
      );
    }
  }

  const finish = (fit: PersonalMealFit, level: number, targets: TargetSet): MemberServingProjection => {
    for (const component of components) {
      component.changed =
        Math.abs(component.proposedQuantity - component.baseQuantity) > 1e-9 ||
        component.cookingMethod !== input.components.find((c) => c.id === component.id)?.cookingMethod;
    }
    // §38: un ingrediente incompatible no puede quedar en la porción final. No
    // se sirve "un poco menos": no se sirve.
    if (fit === "NOT_COMPATIBLE") {
      for (const component of components) {
        component.proposedQuantity = 0;
        component.addedFatG = 0;
      }
    }
    const nutrition = nutritionOf(components);
    return {
      memberId: profile.memberId,
      memberName: profile.memberName,
      versionId: input.versionId,
      mealType,
      fit,
      adaptationLevel: level,
      components,
      nutrition,
      targets,
      metConstraints,
      unmetConstraints,
      unverifiableConstraints,
      reasons,
      suggestions,
      score: scoreOf(nutrition, targets, components, unmetConstraints),
      optimizerVersion: OPTIMIZER_VERSION,
      profileVersion: profile.version,
    };
  };

  // --- Restricciones HARD: no se negocian con una porción más chica (§38) ---
  for (const component of components) {
    const hard = hardBlock(profile, component);
    if (hard.blocked) {
      unmetConstraints.push(`HARD:${component.label}`);
      reasons.push(
        reason("HARD_CONSTRAINT", { component: component.label, reason: hard.type ?? "restricción" }),
      );
      return finish("NOT_COMPATIBLE", 4, {});
    }
  }

  // --- ¿Esta persona hace esta comida? ---
  if (!mealIsEnabled(profile, mealType)) {
    reasons.push(reason("MEAL_DISABLED", { meal: MEAL_TYPE_LABELS[mealType] }));
    return finish("COMPATIBLE", 0, {});
  }

  const targetsBase =
    input.resolvedTargets !== undefined && input.resolvedTargets !== null
      ? input.resolvedTargets
      : effectiveMealTargets(profile, mealType, input.override);

  // §31/§74: un techo clínico confirmado CAPA los objetivos de energía y
  // proteína — el objetivo deportivo puede pedir más proteína, pero jamás por
  // encima del límite médico. La prioridad es estructural, no una opinión.
  const ceilings = input.clinicalCeilings ?? [];
  const clinicalProteinMax = ceilings.find((c) => c.nutrient === "protein_g")?.max ?? null;
  const clinicalEnergyMax = ceilings.find((c) => c.nutrient === "energy_kcal")?.max ?? null;
  let clinicalConflict: { nutrient: string; restrictionId: string } | null = null;

  const targets: TargetSet = { ...targetsBase };
  if (clinicalProteinMax !== null) {
    const p = targets.PROTEIN_G ?? { minimum: null, preferred: null, maximum: null };
    if (p.minimum != null && p.minimum > clinicalProteinMax) {
      // El mínimo deportivo pide MÁS de lo que el límite médico permite:
      // conflicto declarado con razón clínica (§74), nunca un término medio.
      clinicalConflict = { nutrient: "protein_g", restrictionId: ceilings.find((c) => c.nutrient === "protein_g")!.restrictionId };
    }
    targets.PROTEIN_G = {
      ...p,
      minimum: p.minimum != null ? Math.min(p.minimum, clinicalProteinMax) : p.minimum,
      preferred: p.preferred != null ? Math.min(p.preferred, clinicalProteinMax) : p.preferred,
      maximum: p.maximum != null ? Math.min(p.maximum, clinicalProteinMax) : clinicalProteinMax,
    };
  }
  if (clinicalEnergyMax !== null) {
    const e = targets.ENERGY_KCAL ?? { minimum: null, preferred: null, maximum: null };
    targets.ENERGY_KCAL = {
      ...e,
      maximum: e.maximum != null ? Math.min(e.maximum, clinicalEnergyMax) : clinicalEnergyMax,
    };
  }

  // --- Preferencias SOFT: anotan, no prohíben (§12) ---
  for (const component of components) {
    if (!softDislike(profile, component)) continue;
    reasons.push(reason("SOFT_PREFERENCE", { component: component.label }));
    metConstraints.push(`SOFT_NOTED:${component.label}`);

    // Si la receta ofrece un reemplazo culinario y la persona no lo rechaza
    // también, se PROPONE. No se aplica: eso lo decide ella (§37).
    const alternativa = (input.alternatives ?? []).find(
      (a) =>
        a.slotId === component.slotId &&
        !accepted.has(component.id) &&
        !profile.preferences.some(
          (p) =>
            (p.preferenceType === "DISLIKE" ||
              p.preferenceType === "AVOID" ||
              isHardPreference(p.preferenceType)) &&
            p.targetKind === "INGREDIENT" &&
            p.targetId === a.ingredientId,
        ),
    );
    if (alternativa) {
      suggestions.push({
        componentId: component.id,
        componentLabel: component.label,
        ingredientId: alternativa.ingredientId,
        alternativeLabel: alternativa.label,
        reason: `${component.label} no es de tu gusto y la receta acepta ${alternativa.label}.`,
      });
      reasons.push(
        reason("SUBSTITUTION_SUGGESTED", {
          component: component.label,
          alternative: alternativa.label,
        }),
      );
    }
  }

  // --- Preparación y grasa añadida (nivel 2) ---
  let cookingChanged = false;
  for (const component of components) {
    const preferred = preferredMethod(profile, component);
    if (preferred && component.cookingMethod && preferred !== component.cookingMethod) {
      component.cookingMethod = preferred;
      cookingChanged = true;
      reasons.push(
        reason("COOKING_PREFERENCE", {
          component: component.label,
          method: COOKING_METHOD_LABELS[preferred],
        }),
      );
    }
  }

  const addedFats = components.filter(isAddedFat);
  for (const fat of addedFats) {
    if (profile.addedFatStance === "AVOID") {
      if (fat.proposedQuantity > 0) {
        fat.proposedQuantity = 0;
        reasons.push(reason("ADDED_FAT_AVOIDED", { component: fat.label }));
      }
    } else if (profile.addedFatStance === "PREFERRED" && fat.proposedQuantity > 0) {
      reasons.push(
        reason("ADDED_FAT_INCLUDED", {
          component: fat.label,
          grams: Number(fat.proposedQuantity.toFixed(1)),
        }),
      );
    }
  }

  // --- Sin objetivos: porción estándar y punto (tracking OFF, §3 y §10) ---
  if (profile.trackingMode === "OFF" || !hasAnyTarget(targets)) {
    reasons.push(reason(profile.trackingMode === "OFF" ? "NO_TARGETS" : "NO_TARGETS", {}));
    const level = addedFats.some((f) => f.proposedQuantity === 0) || cookingChanged ? 2 : 0;
    return finish(level === 0 ? "COMPATIBLE" : "COMPATIBLE_WITH_COOKING_CHANGE", level, targets);
  }

  const proteinTarget = targets.PROTEIN_G;
  const energyTarget = targets.ENERGY_KCAL;
  let quantitiesChanged = false;

  // --- Ensalada preferida: se sube antes de tocar nada más (§36) ---
  const saladStance = profile.pattern.meals.find((m) => m.mealType === mealType)?.saladPreference;
  if (saladStance === "PREFERRED") {
    for (const component of components.filter((c) => GREEN_SLOTS.includes(c.slotType))) {
      const { max } = bounds(component);
      const target = Math.min(max, component.baseQuantity * 1.25);
      if (target > component.proposedQuantity + 1e-9) {
        component.proposedQuantity = target;
        quantitiesChanged = true;
        reasons.push(reason("SALAD_PREFERENCE", { to: target }));
      }
    }
  }

  // --- Proteína hacia el rango objetivo (§23 paso 3) ---
  if (proteinTarget) {
    const goal = proteinTarget.preferred ?? proteinTarget.minimum ?? null;
    const proteinComponents = components.filter(
      (c) => PROTEIN_SLOTS.includes(c.slotType) && c.adjustability === "ADJUSTABLE",
    );
    if (goal !== null && proteinComponents.length > 0) {
      const current = value(nutritionOf(components), "protein_g");
      const fromProtein = proteinComponents.reduce((sum, c) => {
        const per100 = c.nutrition?.values.protein_g ?? 0;
        return sum + (per100 ?? 0) * (c.proposedQuantity / 100);
      }, 0);
      const missing = goal - current;
      if (Math.abs(missing) > 0.5 && fromProtein > 0) {
        const factor = (fromProtein + missing) / fromProtein;
        for (const component of proteinComponents) {
          const { min, max, declared } = bounds(component);
          const before = component.proposedQuantity;
          const wanted = before * factor;
          const clamped = Math.min(max, Math.max(min, wanted));
          if (Math.abs(clamped - before) > 1e-9) {
            component.proposedQuantity = clamped;
            quantitiesChanged = true;
            reasons.push(
              reason("PROTEIN_TARGET", {
                component: component.label,
                from: before,
                to: clamped,
                min: proteinTarget.minimum ?? 0,
                max: proteinTarget.maximum ?? 0,
                preferred: proteinTarget.preferred ?? goal,
              }),
            );
          }
          if (!declared) {
            reasons.push(reason("MISSING_ADJUSTMENT_LIMITS", { component: component.label }));
            unmetConstraints.push(`NO_LIMITS:${component.label}`);
          }
        }
      }
    }
  }

  // --- Techo de calorías (§23 paso 5, orden de §26) ---
  const calorieMax = energyTarget?.maximum ?? null;
  if (calorieMax !== null) {
    for (const slotType of REDUCTION_ORDER) {
      let energy = value(nutritionOf(components), "energy_kcal");
      if (energy <= calorieMax + 1e-6) break;

      for (const component of components.filter((c) => c.slotType === slotType)) {
        if (component.adjustability === "FIXED") continue;
        energy = value(nutritionOf(components), "energy_kcal");
        if (energy <= calorieMax + 1e-6) break;

        const per100 = component.nutrition?.values.energy_kcal ?? null;
        if (!per100) continue;

        const { min } = bounds(component);
        // Al bajar proteína, nunca por debajo del mínimo del objetivo.
        let floor = min;
        if (PROTEIN_SLOTS.includes(component.slotType) && proteinTarget?.minimum) {
          const proteinPer100 = component.nutrition?.values.protein_g ?? 0;
          if (proteinPer100) {
            const others =
              value(nutritionOf(components), "protein_g") -
              (proteinPer100 * component.proposedQuantity) / 100;
            const needed = ((proteinTarget.minimum - others) / proteinPer100) * 100;
            floor = Math.max(floor, Math.min(component.proposedQuantity, needed));
          }
        }

        const excess = energy - calorieMax;
        const reducible = ((component.proposedQuantity - floor) * per100) / 100;
        const cut = Math.min(excess, Math.max(0, reducible));
        if (cut <= 1e-6) continue;

        const before = component.proposedQuantity;
        component.proposedQuantity = before - (cut * 100) / per100;
        quantitiesChanged = true;
        reasons.push(
          reason("CALORIE_LIMIT", {
            component: component.label,
            from: before,
            to: component.proposedQuantity,
            limit: calorieMax,
          }),
        );
      }
    }
  }

  // --- Techos clínicos de otros nutrientes (§31): reducción proporcional ---
  // Mismo orden y mismos pisos que el techo de calorías: FIXED no se toca y
  // ningún componente baja de su mínimo — una porción diminuta "que cumple"
  // sería maquillaje (§32).
  for (const ceiling of ceilings) {
    if (ceiling.nutrient === "energy_kcal" || ceiling.nutrient === "protein_g") continue;
    for (const slotType of REDUCTION_ORDER) {
      let actual = value(nutritionOf(components), ceiling.nutrient);
      if (actual <= ceiling.max + 1e-6) break;
      for (const component of components.filter((c) => c.slotType === slotType)) {
        if (component.adjustability === "FIXED") continue;
        actual = value(nutritionOf(components), ceiling.nutrient);
        if (actual <= ceiling.max + 1e-6) break;
        const per100 = component.nutrition?.values[ceiling.nutrient] ?? null;
        if (!per100) continue;
        const { min } = bounds(component);
        const excess = actual - ceiling.max;
        const reducible = ((component.proposedQuantity - min) * per100) / 100;
        const cut = Math.min(excess, Math.max(0, reducible));
        if (cut <= 1e-6) continue;
        const before = component.proposedQuantity;
        component.proposedQuantity = before - (cut * 100) / per100;
        quantitiesChanged = true;
        reasons.push(
          reason("CLINICAL_LIMIT", {
            component: component.label,
            nutrient: ceiling.nutrient,
            from: before,
            to: component.proposedQuantity,
            limit: ceiling.max,
          }),
        );
      }
    }
  }

  // --- Validación final: si no se puede, se dice (§27) ---
  const finalNutrition = nutritionOf(components);
  const finalProtein = value(finalNutrition, "protein_g");
  const finalEnergy = value(finalNutrition, "energy_kcal");

  const proteinMin = proteinTarget?.minimum ?? null;
  const proteinOk = proteinMin === null || finalProtein >= proteinMin - 0.5;
  const energyOk = calorieMax === null || finalEnergy <= calorieMax + 0.5;

  // Gate 0→10 [J-1]: un plato con energía DESCONOCIDA sumaba 0 kcal y el techo
  // se declaraba cumplido. "No sé cuántas calorías tiene" no es "tiene pocas":
  // el techo queda SIN VERIFICAR y se dice, en vez de mentir en verde.
  const energiaCompleta = finalNutrition.completeness.energy_kcal === "COMPLETE";
  const proteinaCompleta = finalNutrition.completeness.protein_g === "COMPLETE";

  if (proteinOk) {
    if (proteinMin !== null) {
      // El mínimo con datos parciales sí puede darse por cumplido: lo que falta
      // solo puede SUMAR proteína, nunca restarla.
      metConstraints.push("PROTEIN_MIN");
    }
  } else if (proteinMin !== null && !proteinaCompleta) {
    unverifiableConstraints.push("PROTEIN_MIN");
  } else {
    unmetConstraints.push("PROTEIN_MIN");
  }
  if (calorieMax !== null && !energiaCompleta) {
    // Lo que falta solo puede SUMAR calorías: un techo "cumplido" con datos
    // incompletos no vale, y uno excedido ya está excedido con lo que se sabe.
    if (energyOk) unverifiableConstraints.push("ENERGY_MAX");
    else unmetConstraints.push("ENERGY_MAX");
  } else if (energyOk) {
    if (calorieMax !== null) metConstraints.push("ENERGY_MAX");
  } else {
    unmetConstraints.push("ENERGY_MAX");
  }

  for (const limite of unverifiableConstraints) {
    reasons.push(
      reason("LIMIT_UNVERIFIABLE", {
        limit: limite,
        faltan: components.filter((c) => {
          const v = c.nutrition?.values;
          return c.proposedQuantity > 0 && (!v || v.energy_kcal === null);
        }).length,
      }),
    );
  }

  // Techos clínicos de otros nutrientes: mismo trato honesto que ENERGY_MAX.
  let clinicalOk = true;
  for (const ceiling of ceilings) {
    if (ceiling.nutrient === "energy_kcal" || ceiling.nutrient === "protein_g") continue;
    const etiqueta = `CLINICAL:${ceiling.nutrient}`;
    const completa = finalNutrition.completeness[ceiling.nutrient] === "COMPLETE";
    const total = value(finalNutrition, ceiling.nutrient);
    if (!completa) {
      if (total > ceiling.max + 0.5) {
        // Lo conocido ya excede: excedido, no "sin verificar".
        unmetConstraints.push(etiqueta);
        clinicalOk = false;
        clinicalConflict = clinicalConflict ?? { nutrient: ceiling.nutrient, restrictionId: ceiling.restrictionId };
      } else {
        unverifiableConstraints.push(etiqueta);
      }
    } else if (total > ceiling.max + 0.5) {
      unmetConstraints.push(etiqueta);
      clinicalOk = false;
      clinicalConflict = clinicalConflict ?? { nutrient: ceiling.nutrient, restrictionId: ceiling.restrictionId };
    } else {
      metConstraints.push(etiqueta);
    }
  }

  if (!proteinOk || !energyOk || !clinicalOk || clinicalConflict !== null) {
    if (clinicalConflict !== null) {
      reasons.push(
        reason("CLINICAL_CONFLICT", {
          nutrient: clinicalConflict.nutrient,
          restriction: clinicalConflict.restrictionId,
        }),
      );
    }
    reasons.push(
      reason("TARGET_CONFLICT", { protein: proteinMin ?? 0, calories: calorieMax ?? 0 }),
    );
    return finish("TARGET_CONFLICT", 4, targets);
  }

  if (quantitiesChanged) return finish("COMPATIBLE_WITH_PORTION_CHANGE", 1, targets);
  if (cookingChanged) return finish("COMPATIBLE_WITH_COOKING_CHANGE", 2, targets);
  reasons.push(reason("STANDARD_PORTION", {}));
  return finish("COMPATIBLE", 0, targets);
}

/**
 * Puntaje: cercanía al ideal de proteína, penalizando incumplimientos y número
 * de cambios. Sirve para comparar, no es una nota nutricional.
 */
function scoreOf(
  nutrition: AggregatedNutrition,
  targets: TargetSet,
  components: readonly ServingComponent[],
  unmet: readonly string[],
): number {
  let score = 100;
  const protein = targets.PROTEIN_G;
  if (protein?.preferred) {
    const actual = value(nutrition, "protein_g");
    score -= Math.min(40, (Math.abs(actual - protein.preferred) / protein.preferred) * 100);
  }
  score -= unmet.filter((u) => !u.startsWith("NO_LIMITS")).length * 25;
  score -= components.filter((c) => c.changed).length * 2;
  return Math.max(0, Math.round(score * 1000) / 1000);
}

/** Nutrición por porción ya calculada; se expone dividida por 1 para uniformidad. */
export function servingNutrition(projection: MemberServingProjection): AggregatedNutrition {
  return divideAggregated(projection.nutrition, 1);
}
