import { describe, expect, it } from "vitest";
import type { NutritionFact } from "../catalog/types";
import { calculateMealNutrition, resolveComponentNutrition } from "./nutrition";
import { roundQuantityForDisplay, scaleMealTemplateVersion } from "./scaling";
import type { RecipeComponent, SlotType } from "./types";

// --- Fichas de prueba (por 100 g) -----------------------------------------
const POLLO_RAW: NutritionFact = {
  weightBasis: "RAW",
  basisUnit: "G",
  values: { energy_kcal: 110, protein_g: 23, carbohydrates_g: 0, fat_g: 1.8, phosphorus_mg: 210 },
};
const ARROZ_COOKED: NutritionFact = {
  weightBasis: "COOKED",
  basisUnit: "G",
  // Sin fósforo a propósito: una fuente que no lo informa.
  values: { energy_kcal: 130, protein_g: 2.4, carbohydrates_g: 28, fat_g: 0.3, phosphorus_mg: null },
};
const TOMATE_RAW: NutritionFact = {
  weightBasis: "RAW",
  basisUnit: "G",
  values: { energy_kcal: 18, protein_g: 0.9, carbohydrates_g: 3.9, fat_g: 0.2, phosphorus_mg: 24 },
};
const ACEITE: NutritionFact = {
  weightBasis: "AS_PACKAGED",
  basisUnit: "G",
  values: { energy_kcal: 884, protein_g: 0, carbohydrates_g: 0, fat_g: 100, phosphorus_mg: 0 },
};

let seq = 0;
function component(
  label: string,
  quantity: number,
  fact: NutritionFact | null,
  overrides: Partial<RecipeComponent> = {},
): RecipeComponent {
  seq += 1;
  return {
    id: "c" + seq,
    slotId: "s1",
    slotType: "PROTEIN" as SlotType,
    label,
    target: { kind: "INGREDIENT", ingredientId: "i" + seq },
    quantity,
    unit: "G",
    weightBasis: fact ? fact.weightBasis : "RAW",
    nutrition: fact,
    cookingMethod: null,
    yieldFactor: null,
    isOptional: false,
    sortOrder: seq,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
describe("A. receta con estados mezclados (RAW + COOKED + RAW)", () => {
  const receta = () => [
    component("Pollo", 220, POLLO_RAW),
    component("Arroz", 150, ARROZ_COOKED, { slotType: "CARBOHYDRATE" }),
    component("Tomate", 200, TOMATE_RAW, { slotType: "SALAD" }),
  ];

  it("suma correctamente aunque los ingredientes tengan bases distintas", () => {
    const { total } = calculateMealNutrition(receta(), 2);
    // 110x2,2 + 130x1,5 + 18x2 = 242 + 195 + 36
    expect(total.values.energy_kcal).toBeCloseTo(473, 6);
    // 23x2,2 + 2,4x1,5 + 0,9x2 = 50,6 + 3,6 + 1,8
    expect(total.values.protein_g).toBeCloseTo(56, 6);
    expect(total.completeness.energy_kcal).toBe("COMPLETE");
  });

  it("no mezclar bases NO puede significar no poder sumar una receta real", () => {
    expect(() => calculateMealNutrition(receta(), 2)).not.toThrow();
  });

  it("divide por porciones base conservando la completitud", () => {
    const { perServing } = calculateMealNutrition(receta(), 2);
    expect(perServing.values.energy_kcal).toBeCloseTo(236.5, 6);
    expect(perServing.completeness.energy_kcal).toBe("COMPLETE");
  });

  it("sigue rechazando interpretar una ficha COOKED como si fuera RAW", () => {
    const malo = component("Arroz", 150, ARROZ_COOKED, { weightBasis: "RAW" });
    expect(() => resolveComponentNutrition(malo)).toThrow(/ficha/i);
  });

  it("sigue rechazando g y ml sin equivalencia", () => {
    const enMl: NutritionFact = { ...POLLO_RAW, basisUnit: "ML" };
    const malo = component("Caldo", 100, enMl, { unit: "G" });
    expect(() => resolveComponentNutrition(malo)).toThrow(/incompatible/i);
  });
});

// ---------------------------------------------------------------------------
describe("B. escalar 5 -> 6 porciones", () => {
  const version = () => ({
    baseServings: 5,
    components: [
      component("Pollo", 900, POLLO_RAW),
      component("Arroz", 600, ARROZ_COOKED, { slotType: "CARBOHYDRATE" as SlotType }),
    ],
  });

  it("escala las cantidades por 6/5", () => {
    const scaled = scaleMealTemplateVersion(version(), 6);
    expect(scaled.factor).toBeCloseTo(1.2, 10);
    expect(scaled.components[0]!.quantity).toBeCloseTo(1080, 6);
    expect(scaled.components[1]!.quantity).toBeCloseTo(720, 6);
  });

  it("es una proyección: no muta la versión persistida", () => {
    const v = version();
    scaleMealTemplateVersion(v, 12);
    expect(v.components[0]!.quantity).toBe(900);
    expect(v.baseServings).toBe(5);
  });

  it("conserva la cantidad base para mostrar el antes y el después", () => {
    const scaled = scaleMealTemplateVersion(version(), 6);
    expect(scaled.components[0]!.baseQuantity).toBe(900);
  });

  it("la nutrición por porción no cambia al escalar", () => {
    const v = version();
    const base = calculateMealNutrition(v.components, 5);
    const scaled = scaleMealTemplateVersion(v, 6);
    expect(scaled.nutrition.perServing.values.energy_kcal).toBeCloseTo(
      base.perServing.values.energy_kcal!,
      6,
    );
  });

  it("redondea solo para mostrar, nunca para calcular", () => {
    expect(roundQuantityForDisplay(1079.9999999)).toBe(1080);
    expect(roundQuantityForDisplay(8.126)).toBe(8.13);
  });
});

// ---------------------------------------------------------------------------
describe("C. nutriente desconocido en un ingrediente: PARTIAL, nunca cero", () => {
  const receta = () => [
    component("Pollo", 220, POLLO_RAW),
    component("Arroz", 150, ARROZ_COOKED, { slotType: "CARBOHYDRATE" }),
    component("Tomate", 200, TOMATE_RAW, { slotType: "SALAD" }),
  ];

  it("marca el fósforo como PARTIAL porque el arroz no lo informa", () => {
    const { total } = calculateMealNutrition(receta(), 2);
    expect(total.completeness.phosphorus_mg).toBe("PARTIAL");
  });

  it("el valor parcial es la suma de lo conocido, jamás presentado como total", () => {
    const { total } = calculateMealNutrition(receta(), 2);
    // 210x2,2 + 24x2 = 462 + 48, pero marcado PARTIAL
    expect(total.values.phosphorus_mg).toBeCloseTo(510, 6);
    expect(total.completeness.phosphorus_mg).not.toBe("COMPLETE");
  });

  it("si nadie lo informa queda UNKNOWN con valor null, no 0", () => {
    const { total } = calculateMealNutrition(receta(), 2);
    expect(total.completeness.potassium_mg).toBe("UNKNOWN");
    expect(total.values.potassium_mg).toBeNull();
  });

  it("un componente SIN ficha no aporta ceros: vuelve incompleto el total", () => {
    const conMisterio = [...receta(), component("Aliño casero", 30, null, { slotType: "SAUCE" })];
    const { total } = calculateMealNutrition(conMisterio, 2);
    expect(total.completeness.energy_kcal).toBe("PARTIAL");
    expect(total.values.energy_kcal).toBeCloseTo(473, 6);
  });
});

// ---------------------------------------------------------------------------
describe("F. un slot con varios ingredientes", () => {
  it("la ensalada chilena son cuatro componentes del mismo slot", () => {
    const ensalada: RecipeComponent[] = [
      component("Tomate", 400, TOMATE_RAW, { slotId: "salad", slotType: "SALAD" }),
      component("Cebolla", 150, TOMATE_RAW, { slotId: "salad", slotType: "SALAD" }),
      component("Cilantro", 20, TOMATE_RAW, { slotId: "salad", slotType: "SALAD" }),
      component("Limón", 50, TOMATE_RAW, { slotId: "salad", slotType: "SALAD" }),
    ];
    const { total, componentCount } = calculateMealNutrition(ensalada, 4);
    expect(componentCount).toBe(4);
    expect(new Set(ensalada.map((c) => c.slotId)).size).toBe(1);
    // 18 kcal/100 g x (400+150+20+50)/100 = 18 x 6,2
    expect(total.values.energy_kcal).toBeCloseTo(111.6, 6);
  });
});

// ---------------------------------------------------------------------------
describe("aderezos y grasas son ingredientes reales, no un booleano", () => {
  it("8 g de aceite aportan kcal y grasa al total", () => {
    const sinAceite = calculateMealNutrition([component("Tomate", 200, TOMATE_RAW)], 1);
    const conAceite = calculateMealNutrition(
      [component("Tomate", 200, TOMATE_RAW), component("Aceite", 8, ACEITE, { slotType: "FAT" })],
      1,
    );
    expect(conAceite.total.values.energy_kcal!).toBeCloseTo(
      sinAceite.total.values.energy_kcal! + 70.72,
      6,
    );
    expect(conAceite.total.values.fat_g!).toBeGreaterThan(sinAceite.total.values.fat_g!);
  });

  it("se pueden excluir los opcionales sin borrarlos de la receta", () => {
    const componentes = [
      component("Tomate", 200, TOMATE_RAW),
      component("Aceite", 8, ACEITE, { slotType: "FAT", isOptional: true }),
    ];
    const con = calculateMealNutrition(componentes, 1);
    const sin = calculateMealNutrition(componentes, 1, { includeOptional: false });
    expect(sin.componentCount).toBe(1);
    expect(con.total.values.energy_kcal!).toBeGreaterThan(sin.total.values.energy_kcal!);
  });
});

// ---------------------------------------------------------------------------
describe("rendimiento crudo a cocido", () => {
  it("desconocido es null, nunca 100 % asumido", () => {
    expect(component("Pollo", 900, POLLO_RAW).yieldFactor).toBeNull();
    expect(component("Pollo", 900, POLLO_RAW, { yieldFactor: 0.72 }).yieldFactor).toBe(0.72);
  });
});

// ---------------------------------------------------------------------------
describe("validaciones de porciones", () => {
  it("rechaza porciones base no enteras o menores o iguales a 0", () => {
    const c = [component("Pollo", 100, POLLO_RAW)];
    expect(() => calculateMealNutrition(c, 0)).toThrow();
    expect(() => calculateMealNutrition(c, 2.5)).toThrow();
  });

  it("rechaza escalar a 0 porciones", () => {
    expect(() => scaleMealTemplateVersion({ baseServings: 4, components: [] }, 0)).toThrow();
  });
});
