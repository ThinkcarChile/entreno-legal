import type { MealType } from "../recipes/types";
import type { MemberNutritionProfile, TargetSet } from "../nutrition/types";
import { optimizePortion, type MemberServingProjection, type PortionComponent } from "./optimizer";

/**
 * FamilyServingProjector (§32) y totales para cocinar (§33, §34).
 *
 * Corre el PortionOptimizer para cada integrante y después suma. El total NO es
 * "la receta × personas": es la suma exacta de las porciones reales, que es lo
 * que después va a necesitar el ShoppingEngine.
 */

export interface FamilyProjectionInput {
  versionId: string;
  components: readonly PortionComponent[];
  baseServings: number;
  mealType: MealType;
  members: {
    profile: MemberNutritionProfile;
    /** Excepción del día de esta persona, si tiene. */
    override?: TargetSet | null;
  }[];
}

export interface PreparationTotal {
  componentId: string;
  label: string;
  unit: string;
  total: number;
  addedFatG: number;
  /** Cuánto va por cada método de cocción (§34). */
  byMethod: { method: string | null; quantity: number; members: string[] }[];
  perMember: { memberName: string; quantity: number }[];
}

export interface FamilyServingProjection {
  mealType: MealType;
  servings: MemberServingProjection[];
  totals: PreparationTotal[];
  /** Personas para las que la receta no funciona tal cual. */
  needsAttention: { memberName: string; fit: string }[];
}

export function projectFamilyServings(input: FamilyProjectionInput): FamilyServingProjection {
  const servings = input.members.map(({ profile, override }) =>
    optimizePortion({
      versionId: input.versionId,
      components: input.components,
      baseServings: input.baseServings,
      profile,
      mealType: input.mealType,
      override,
    }),
  );

  const totals = preparationTotals(servings);

  return {
    mealType: input.mealType,
    servings,
    totals,
    needsAttention: servings
      .filter((s) => s.fit === "TARGET_CONFLICT" || s.fit === "NOT_COMPATIBLE")
      .map((s) => ({ memberName: s.memberName, fit: s.fit })),
  };
}

/**
 * Suma exacta por ingrediente. Si dos personas usan métodos distintos, se agrupa
 * por método: 400 g al horno y 240 g fritos, no 640 g "de alguna manera" (§34).
 */
export function preparationTotals(
  servings: readonly MemberServingProjection[],
): PreparationTotal[] {
  const byComponent = new Map<string, PreparationTotal>();

  for (const serving of servings) {
    // Una persona NOT_COMPATIBLE no come este plato: no aporta al total.
    if (serving.fit === "NOT_COMPATIBLE") continue;

    for (const component of serving.components) {
      if (component.proposedQuantity <= 0 && component.addedFatG <= 0) continue;

      let entry = byComponent.get(component.id);
      if (!entry) {
        entry = {
          componentId: component.id,
          label: component.label,
          unit: component.unit === "G" ? "g" : "ml",
          total: 0,
          addedFatG: 0,
          byMethod: [],
          perMember: [],
        };
        byComponent.set(component.id, entry);
      }

      entry.total += component.proposedQuantity;
      entry.addedFatG += component.addedFatG;
      entry.perMember.push({
        memberName: serving.memberName,
        quantity: component.proposedQuantity,
      });

      const method = component.cookingMethod ?? null;
      const group = entry.byMethod.find((g) => g.method === method);
      if (group) {
        group.quantity += component.proposedQuantity;
        group.members.push(serving.memberName);
      } else {
        entry.byMethod.push({
          method,
          quantity: component.proposedQuantity,
          members: [serving.memberName],
        });
      }
    }
  }

  return [...byComponent.values()];
}

/** Sí, es una suma. Se expone como función para poder probar el invariante (§49 O). */
export function totalFor(totals: readonly PreparationTotal[], label: string): number {
  return totals.filter((t) => t.label === label).reduce((sum, t) => sum + t.total, 0);
}
