import { describe, expect, it } from "vitest";
import {
  calculateNutritionForQuantity,
  combineNutrition,
  normalizeLabelToPer100,
  quantityFromServings,
  roundForDisplay,
} from "./nutrition";

describe("A. normalización de etiqueta por porción a 100 g", () => {
  it("48 g = 90 kcal → 187,5 kcal/100 g, conservando el original", () => {
    const result = normalizeLabelToPer100({
      servingQuantity: 48,
      servingUnit: "G",
      values: { energy_kcal: 90, protein_g: 6.3, carbohydrates_g: 14.3, fat_g: 0.8 },
    });
    expect(result.per100.energy_kcal).toBeCloseTo(187.5, 6);
    expect(result.per100.protein_g).toBeCloseTo(13.125, 6);
    expect(result.per100.carbohydrates_g).toBeCloseTo(29.7916666, 5);
    expect(result.per100.fat_g).toBeCloseTo(1.6666666, 5);
    // El dato original nunca se pierde
    expect(result.original.servingQuantity).toBe(48);
    expect(result.original.values.energy_kcal).toBe(90);
  });

  it("rechaza porción cero o negativa", () => {
    expect(() =>
      normalizeLabelToPer100({ servingQuantity: 0, servingUnit: "G", values: {} }),
    ).toThrow();
  });
});

describe("B. cálculo por peso consumido", () => {
  it("250 kcal/100 g × 73 g = 182,5 kcal", () => {
    const result = calculateNutritionForQuantity({ energy_kcal: 250 }, 73, "G", "G");
    expect(result.energy_kcal).toBeCloseTo(182.5, 9);
  });

  it("no redondea internamente (la UI redondea)", () => {
    const result = calculateNutritionForQuantity({ protein_g: 6.3 }, 33, "G", "G");
    expect(result.protein_g).toBeCloseTo(2.079, 9);
    expect(roundForDisplay(result.protein_g, 1)).toBe(2.1);
  });
});

describe("C. todos los macros simultáneamente", () => {
  it("escala cada nutriente disponible", () => {
    const per100 = {
      energy_kcal: 187.5,
      protein_g: 13.125,
      carbohydrates_g: 29.792,
      fat_g: 1.667,
      fiber_g: 6.25,
      sodium_mg: 458.333,
    };
    const result = calculateNutritionForQuantity(per100, 48, "G", "G");
    expect(result.energy_kcal).toBeCloseTo(90, 3);
    expect(result.protein_g).toBeCloseTo(6.3, 3);
    expect(result.carbohydrates_g).toBeCloseTo(14.3, 2);
    expect(result.fat_g).toBeCloseTo(0.8, 2);
    expect(result.fiber_g).toBeCloseTo(3.0, 3);
    expect(result.sodium_mg).toBeCloseTo(220, 1);
  });
});

describe("D. datos faltantes: UNKNOWN != ZERO", () => {
  it("un nutriente ausente queda null, nunca 0", () => {
    const result = calculateNutritionForQuantity(
      { energy_kcal: 100, potassium_mg: null },
      50,
      "G",
      "G",
    );
    expect(result.energy_kcal).toBe(50);
    expect(result.potassium_mg).toBeNull();
    expect(result.phosphorus_mg).toBeNull(); // ni siquiera estaba en el input
  });

  it("la normalización de etiqueta también propaga null", () => {
    const result = normalizeLabelToPer100({
      servingQuantity: 48,
      servingUnit: "G",
      values: { energy_kcal: 90 },
    });
    expect(result.per100.potassium_mg).toBeNull();
  });

  it("al combinar, un desconocido vuelve desconocida la suma", () => {
    const combined = combineNutrition([
      { values: { energy_kcal: 100, sodium_mg: 50 }, weightBasis: "RAW", basisUnit: "G" },
      { values: { energy_kcal: 30, sodium_mg: null }, weightBasis: "RAW", basisUnit: "G" },
    ]);
    expect(combined.values.energy_kcal).toBe(130);
    expect(combined.values.sodium_mg).toBeNull(); // NO 50
  });
});

describe("E. crudo vs cocido no se mezclan", () => {
  it("combinar RAW con COOKED lanza error", () => {
    expect(() =>
      combineNutrition([
        { values: { energy_kcal: 360 }, weightBasis: "RAW", basisUnit: "G" },
        { values: { energy_kcal: 130 }, weightBasis: "COOKED", basisUnit: "G" },
      ]),
    ).toThrow(/bases distintas/);
  });

  it("g y ml tampoco se mezclan sin equivalencia", () => {
    expect(() => calculateNutritionForQuantity({ energy_kcal: 824 }, 15, "G", "ML")).toThrow(
      /incompatible/,
    );
  });
});

describe("porciones comerciales", () => {
  it("2 rebanadas de 35 g = 70 g", () => {
    expect(quantityFromServings(2, 35)).toBe(70);
  });

  it("el peso real tiene prioridad: 2 rebanadas = 73 g", () => {
    expect(quantityFromServings(2, 35, 73)).toBe(73);
  });

  it("sin porción definida y sin peso real, falla explícitamente", () => {
    expect(() => quantityFromServings(2, 0)).toThrow();
  });
});
