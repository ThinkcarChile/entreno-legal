import { describe, expect, it } from "vitest";
import type { NutritionFact } from "../catalog/types";
import { calculateMealNutrition } from "./nutrition";
import { assertEditable, canEditInPlace, draftFromVersion, nextVersionNumber } from "./versioning";
import type { MealTemplateVersion, RecipeComponent, SlotAlternative } from "./types";

function fact(kcal: number): NutritionFact {
  return {
    weightBasis: "RAW",
    basisUnit: "G",
    values: { energy_kcal: kcal, protein_g: 20, carbohydrates_g: 0, fat_g: 2 },
  };
}

function componente(label: string, quantity: number, nutrition: NutritionFact): RecipeComponent {
  return {
    id: "c-" + label,
    slotId: "s-protein",
    slotType: "PROTEIN",
    label,
    target: { kind: "INGREDIENT", ingredientId: "ing-" + label },
    quantity,
    unit: "G",
    weightBasis: "RAW",
    nutrition,
    cookingMethod: "BAKED",
    yieldFactor: null,
    isOptional: false,
    sortOrder: 1,
    adjustability: "ADJUSTABLE",
    minQuantity: null,
    maxQuantity: null,
    categoryId: null,
  };
}

function versionPublicada(): MealTemplateVersion {
  return {
    id: "v1",
    templateId: "t1",
    versionNumber: 1,
    status: "PUBLISHED",
    name: "Pollo con arroz y ensalada chilena",
    mealTypes: ["LUNCH"],
    baseServings: 5,
    baseTimeMinutes: 40,
    totalYieldFactor: null,
    slots: [{ id: "s-protein", slotType: "PROTEIN", label: null, isRequired: true, sortOrder: 1 }],
    components: [componente("Pollo", 900, fact(110))],
    steps: [
      {
        id: "st1",
        stepNumber: 1,
        instruction: "Hornear el pollo 25 minutos.",
        durationMinutes: 25,
        temperatureC: 200,
        requiredCapability: null,
        optionalCapability: "AIR_FRYER",
        manualAlternative: "En horno tradicional, 30 minutos a 200 °C.",
        parallelGroup: 1,
        notes: null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
describe("D. publicar v1, editar, obtener v2 sin tocar v1", () => {
  it("una versión publicada no se edita en sitio", () => {
    expect(canEditInPlace("PUBLISHED")).toBe(false);
    expect(canEditInPlace("ARCHIVED")).toBe(false);
    expect(canEditInPlace("DRAFT")).toBe(true);
    expect(() => assertEditable("PUBLISHED")).toThrow(/nueva versión/i);
  });

  it("editar genera la versión siguiente en estado borrador", () => {
    const v1 = versionPublicada();
    const v2 = draftFromVersion(v1, [v1]);
    expect(v2.versionNumber).toBe(2);
    expect(v2.status).toBe("DRAFT");
    expect(nextVersionNumber([v1, v2])).toBe(3);
  });

  it("v1 queda idéntica después de modificar v2", () => {
    const v1 = versionPublicada();
    const snapshot = JSON.stringify(v1);
    const v2 = draftFromVersion(v1, [v1]);

    v2.name = "Pollo con quinoa";
    v2.baseServings = 6;
    v2.components[0]!.quantity = 1200;
    v2.components[0]!.nutrition!.values.energy_kcal = 999;
    v2.steps[0]!.instruction = "Otra cosa";

    expect(JSON.stringify(v1)).toBe(snapshot);
    expect(v1.components[0]!.quantity).toBe(900);
    expect(v1.components[0]!.nutrition!.values.energy_kcal).toBe(110);
    expect(v1.name).toBe("Pollo con arroz y ensalada chilena");
  });
});

// ---------------------------------------------------------------------------
describe("E. corregir la ficha del catálogo no reescribe la historia", () => {
  it("la versión publicada sigue calculando con su ficha congelada", () => {
    // La ficha tal como estaba en el catálogo al publicar.
    const fichaCatalogo = fact(110);
    const v1: MealTemplateVersion = {
      ...versionPublicada(),
      components: [componente("Pollo", 900, { ...fichaCatalogo, values: { ...fichaCatalogo.values } })],
    };
    const antes = calculateMealNutrition(v1.components, v1.baseServings);

    // Mañana el catálogo corrige el dato del alimento.
    fichaCatalogo.values.energy_kcal = 165;

    const despues = calculateMealNutrition(v1.components, v1.baseServings);
    expect(despues.total.values.energy_kcal).toBeCloseTo(antes.total.values.energy_kcal!, 6);
    expect(despues.total.values.energy_kcal).toBeCloseTo(990, 6); // 110 x 9
  });

  it("la corrección sí se refleja al publicar una versión nueva", () => {
    const v1 = versionPublicada();
    const v2 = draftFromVersion(v1, [v1]);
    // Al re-publicar se vuelve a congelar la ficha vigente del catálogo.
    v2.components[0]!.nutrition = fact(165);

    const nutricionV1 = calculateMealNutrition(v1.components, v1.baseServings);
    const nutricionV2 = calculateMealNutrition(v2.components, v2.baseServings);
    expect(nutricionV1.total.values.energy_kcal).toBeCloseTo(990, 6);
    expect(nutricionV2.total.values.energy_kcal).toBeCloseTo(1485, 6);
  });
});

// ---------------------------------------------------------------------------
describe("G. alternativa culinaria no implica equivalencia nutricional", () => {
  const alternativa: SlotAlternative = {
    id: "alt1",
    slotId: "s-protein",
    label: "Merluza",
    target: { kind: "INGREDIENT", ingredientId: "ing-merluza" },
    culinaryCompatibility: "GOOD",
    quantityEquivalence: null,
    notes: "Reemplaza al pollo en el mismo plato.",
  };

  it("la alternativa declara compatibilidad de cocina, no de nutrientes", () => {
    expect(alternativa.culinaryCompatibility).toBe("GOOD");
    expect(alternativa.quantityEquivalence).toBeNull();
    expect(Object.keys(alternativa)).not.toContain("nutritionalEquivalence");
  });

  it("misma cantidad de la alternativa da OTRA nutrición: nada se asume equivalente", () => {
    const conPollo = calculateMealNutrition([componente("Pollo", 200, fact(110))], 1);
    const conPescado = calculateMealNutrition([componente("Merluza", 200, fact(82))], 1);
    expect(conPollo.total.values.energy_kcal).toBeCloseTo(220, 6);
    expect(conPescado.total.values.energy_kcal).toBeCloseTo(164, 6);
    expect(conPollo.total.values.energy_kcal).not.toBeCloseTo(
      conPescado.total.values.energy_kcal!,
      6,
    );
  });

  it("las alternativas no participan del cálculo de la versión", () => {
    const v1 = versionPublicada();
    const nutricion = calculateMealNutrition(v1.components, v1.baseServings);
    expect(nutricion.componentCount).toBe(1);
  });
});
