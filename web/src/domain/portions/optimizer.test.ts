import { describe, expect, it } from "vitest";
import type { NutritionFact } from "../catalog/types";
import { buildProfile, firstMeal, mealIsEnabled, signature } from "../nutrition/profile";
import type { MemberNutritionProfile, TargetSet } from "../nutrition/types";
import { optimizePortion, type PortionComponent } from "./optimizer";
import { projectFamilyServings, preparationTotals } from "./family";

// --- Catálogo de prueba (por 100 g, salvo el aceite que va por 100 ml) ------
const POLLO: NutritionFact = {
  weightBasis: "RAW",
  basisUnit: "G",
  values: { energy_kcal: 110, protein_g: 23, carbohydrates_g: 0, fat_g: 1.8, phosphorus_mg: 210 },
};
const ARROZ: NutritionFact = {
  weightBasis: "RAW",
  basisUnit: "G",
  // Sin fósforo a propósito: sirve para el caso N.
  values: { energy_kcal: 360, protein_g: 6.6, carbohydrates_g: 79, fat_g: 0.6, phosphorus_mg: null },
};
const ENSALADA: NutritionFact = {
  weightBasis: "RAW",
  basisUnit: "G",
  values: { energy_kcal: 18, protein_g: 0.9, carbohydrates_g: 3.9, fat_g: 0.2, phosphorus_mg: 24 },
};
const ACEITE: NutritionFact = {
  weightBasis: "AS_PACKAGED",
  basisUnit: "ML",
  values: { energy_kcal: 824, protein_g: 0, carbohydrates_g: 0, fat_g: 91.6, phosphorus_mg: 0 },
};

const ING = { pollo: "ing-pollo", arroz: "ing-arroz", ensalada: "ing-tomate", aceite: "ing-aceite", cerdo: "ing-cerdo" };

/** Pollo + arroz + ensalada + aceite opcional, receta base para 5. */
function receta(): PortionComponent[] {
  return [
    {
      id: "c-pollo", slotId: "s-protein", label: "Pollo", slotType: "PROTEIN", quantity: 900, unit: "G",
      weightBasis: "RAW", nutrition: POLLO, cookingMethod: "BAKED", adjustability: "ADJUSTABLE",
      minQuantity: 500, maxQuantity: 1400, ingredientId: ING.pollo, categoryId: "cat-aves", isOptional: false, role: "MAIN",
    },
    {
      id: "c-arroz", slotId: "s-carbo", label: "Arroz", slotType: "CARBOHYDRATE", quantity: 375, unit: "G",
      weightBasis: "RAW", nutrition: ARROZ, cookingMethod: "BOILED", adjustability: "ADJUSTABLE",
      minQuantity: 150, maxQuantity: 600, ingredientId: ING.arroz, categoryId: "cat-granos", isOptional: false, role: "MAIN",
    },
    {
      id: "c-ensalada", slotId: "s-salad", label: "Ensalada", slotType: "SALAD", quantity: 570, unit: "G",
      weightBasis: "RAW", nutrition: ENSALADA, cookingMethod: "RAW", adjustability: "ADJUSTABLE",
      minQuantity: 300, maxQuantity: 900, ingredientId: ING.ensalada, categoryId: "cat-verduras", isOptional: false, role: "MAIN",
    },
    {
      id: "c-aceite", slotId: "s-fat", label: "Aceite de oliva", slotType: "FAT", quantity: 20, unit: "ML",
      weightBasis: "AS_PACKAGED", nutrition: ACEITE, cookingMethod: null, adjustability: "OPTIONAL",
      minQuantity: 0, maxQuantity: 40, ingredientId: ING.aceite, categoryId: "cat-aceites", isOptional: true, role: "ADDED_FAT",
    },
  ];
}

const patronConAlmuerzo = (saladPreference: "PREFERRED" | "NEUTRAL" = "NEUTRAL") => ({
  usesFastingPattern: true,
  firstMealType: "LUNCH" as const,
  feedingWindowStart: null,
  feedingWindowEnd: null,
  meals: [
    { mealType: "BREAKFAST" as const, availability: "DISABLED" as const, isFirstMeal: false, saladPreference: "NEUTRAL" as const, priority: 100 },
    { mealType: "LUNCH" as const, availability: "ENABLED" as const, isFirstMeal: true, saladPreference, priority: 10 },
    { mealType: "DINNER" as const, availability: "ENABLED" as const, isFirstMeal: false, saladPreference: "NEUTRAL" as const, priority: 30 },
  ],
});

/** Francisco: FULL, proteína 50–80 (ideal 65), máximo 800 kcal, sin aceite. */
function francisco(mealGoals: { min?: number; pref?: number; max?: number; kcalMax?: number } = {}) {
  return buildProfile({
    memberId: "m-francisco", memberName: "Francisco", trackingMode: "FULL",
    goals: [
      { goalType: "PROTEIN_G", scope: "DAILY", mealType: null, minimum: 130, preferred: 130, maximum: null, priority: 10 },
      { goalType: "PROTEIN_G", scope: "PER_MEAL", mealType: "LUNCH",
        minimum: mealGoals.min ?? 50, preferred: mealGoals.pref ?? 65, maximum: mealGoals.max ?? 80, priority: 10 },
      { goalType: "ENERGY_KCAL", scope: "PER_MEAL", mealType: "LUNCH",
        minimum: null, preferred: null, maximum: mealGoals.kcalMax ?? 800, priority: 20 },
    ],
    pattern: patronConAlmuerzo("PREFERRED"),
    preferences: [],
    cookingPreferences: [
      { ingredientId: ING.pollo, categoryId: null, cookingMethod: "AIR_FRYER", stance: "PREFERRED" },
    ],
    addedFatStance: "AVOID",
  });
}

/** Paula: tracking OFF, sin objetivos. */
function paula() {
  return buildProfile({
    memberId: "m-paula", memberName: "Paula", trackingMode: "OFF", goals: [],
    pattern: { usesFastingPattern: false, firstMealType: null, feedingWindowStart: null, feedingWindowEnd: null,
      meals: [{ mealType: "LUNCH", availability: "ENABLED", isFirstMeal: false, saladPreference: "NEUTRAL", priority: 10 }] },
    preferences: [], cookingPreferences: [], addedFatStance: "ALLOWED",
  });
}

/** Sebastián: frito preferido, acepta grasa añadida, cerdo no le gusta (SOFT). */
function sebastian(proteinPref = 60) {
  return buildProfile({
    memberId: "m-sebastian", memberName: "Sebastián", trackingMode: "BASIC",
    goals: [
      { goalType: "PROTEIN_G", scope: "PER_MEAL", mealType: "LUNCH", minimum: 45, preferred: proteinPref, maximum: 90, priority: 10 },
    ],
    pattern: patronConAlmuerzo(),
    preferences: [{ preferenceType: "DISLIKE", targetKind: "INGREDIENT", targetId: ING.cerdo }],
    cookingPreferences: [{ ingredientId: ING.pollo, categoryId: null, cookingMethod: "FRIED", stance: "PREFERRED" }],
    addedFatStance: "ALLOWED",
  });
}

const correr = (profile: MemberNutritionProfile, override?: TargetSet | null, componentes = receta()) =>
  optimizePortion({ versionId: "v-1", components: componentes, baseServings: 5, profile, mealType: "LUNCH", override });

const kcal = (p: ReturnType<typeof correr>) => p.nutrition.values.energy_kcal ?? 0;
const prot = (p: ReturnType<typeof correr>) => p.nutrition.values.protein_g ?? 0;
const cant = (p: ReturnType<typeof correr>, id: string) =>
  p.components.find((c) => c.id === id)!.proposedQuantity;

// ---------------------------------------------------------------------------
describe("A. tracking OFF: porción estándar válida, sin macros inventados", () => {
  const resultado = correr(paula());

  it("recibe exactamente la porción base dividida por 5", () => {
    expect(cant(resultado, "c-pollo")).toBeCloseTo(180, 6);
    expect(cant(resultado, "c-arroz")).toBeCloseTo(75, 6);
    expect(resultado.adaptationLevel).toBe(0);
    expect(resultado.fit).toBe("COMPATIBLE");
  });

  it("no se le inventan objetivos", () => {
    expect(resultado.targets).toEqual({});
    expect(resultado.reasons.some((r) => r.code === "NO_TARGETS")).toBe(true);
  });

  it("igual se le calcula la nutrición: OFF no es estar excluida", () => {
    expect(kcal(resultado)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("B. proteína: se sube el pollo para alcanzar el rango", () => {
  const resultado = correr(francisco());

  it("aumenta la proteína respecto de la porción estándar", () => {
    expect(cant(resultado, "c-pollo")).toBeGreaterThan(180);
    expect(prot(resultado)).toBeGreaterThan(47);
  });

  it("queda dentro del rango objetivo", () => {
    expect(prot(resultado)).toBeGreaterThanOrEqual(50);
    expect(prot(resultado)).toBeLessThanOrEqual(80);
  });

  it("lo explica con código y parámetros, no con texto suelto", () => {
    const r = resultado.reasons.find((x) => x.code === "PROTEIN_TARGET");
    expect(r).toBeDefined();
    expect(r!.params.component).toBe("Pollo");
    expect(r!.text).toContain("proteína");
  });

  it("respeta el máximo declarado del componente", () => {
    expect(cant(resultado, "c-pollo")).toBeLessThanOrEqual(1400 / 5);
  });
});

// ---------------------------------------------------------------------------
describe("C. techo de calorías: se recorta, y no por la ensalada", () => {
  const resultado = correr(francisco({ kcalMax: 450, min: 40, pref: 45, max: 80 }));

  it("cumple el máximo", () => {
    expect(kcal(resultado)).toBeLessThanOrEqual(450.5);
  });

  it("recorta el carbohidrato antes que la ensalada (§26)", () => {
    expect(cant(resultado, "c-arroz")).toBeLessThan(75);
    expect(cant(resultado, "c-ensalada")).toBeGreaterThanOrEqual(114);
  });

  it("la grasa opcional se fue primero", () => {
    expect(cant(resultado, "c-aceite")).toBe(0);
  });

  it("lo explica", () => {
    expect(resultado.reasons.some((r) => r.code === "CALORIE_LIMIT")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("D. conflicto: no inventa una solución que no existe (§27)", () => {
  const resultado = correr(francisco({ min: 95, pref: 100, max: 120, kcalMax: 380 }));

  it("devuelve TARGET_CONFLICT", () => {
    expect(resultado.fit).toBe("TARGET_CONFLICT");
    expect(resultado.adaptationLevel).toBe(4);
  });

  it("dice cuál objetivo no se pudo cumplir", () => {
    expect(resultado.unmetConstraints.length).toBeGreaterThan(0);
    const r = resultado.reasons.find((x) => x.code === "TARGET_CONFLICT");
    expect(r!.text).toMatch(/no es posible/i);
  });
});

// ---------------------------------------------------------------------------
describe("E. rangos: 62 dentro de 50–80 es válido (§24)", () => {
  it("no exige clavar el ideal", () => {
    const resultado = correr(francisco());
    const p = prot(resultado);
    expect(p).toBeGreaterThanOrEqual(50);
    expect(p).toBeLessThanOrEqual(80);
    expect(resultado.metConstraints).toContain("PROTEIN_MIN");
    expect(resultado.fit).not.toBe("TARGET_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
describe("F. excepción del día: solo ese día cambia (§19, §20)", () => {
  const habitual = correr(francisco({ kcalMax: 800 }));
  const sabado = correr(francisco({ kcalMax: 800 }), {
    ENERGY_KCAL: { minimum: null, preferred: null, maximum: 1000 },
  });

  it("el sábado permite más energía", () => {
    expect(sabado.targets.ENERGY_KCAL?.maximum).toBe(1000);
    expect(habitual.targets.ENERGY_KCAL?.maximum).toBe(800);
  });

  it("el patrón habitual no se modifica", () => {
    const otraVez = correr(francisco({ kcalMax: 800 }));
    expect(otraVez.targets.ENERGY_KCAL?.maximum).toBe(800);
  });

  it("la excepción no toca los objetivos que no menciona", () => {
    expect(sabado.targets.PROTEIN_G?.preferred).toBe(65);
  });
});

// ---------------------------------------------------------------------------
describe("G. ayuno: desayuno desactivado no reserva nada (§8)", () => {
  const p = francisco();

  it("el desayuno no está habilitado", () => {
    expect(mealIsEnabled(p, "BREAKFAST")).toBe(false);
    expect(mealIsEnabled(p, "LUNCH")).toBe(true);
  });

  it("el almuerzo es la primera comida", () => {
    expect(firstMeal(p)).toBe("LUNCH");
  });

  it("pedir una porción de desayuno no genera objetivos", () => {
    const desayuno = optimizePortion({
      versionId: "v-1", components: receta(), baseServings: 5, profile: p, mealType: "BREAKFAST",
    });
    expect(desayuno.targets).toEqual({});
    expect(desayuno.reasons.some((r) => r.code === "MEAL_DISABLED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("H. preferencias de cocción y agrupación por método (§14, §34)", () => {
  const familia = projectFamilyServings({
    versionId: "v-1", components: receta(), baseServings: 5, mealType: "LUNCH",
    members: [{ profile: francisco() }, { profile: sebastian() }, { profile: paula() }],
  });

  it("cada uno cocina el pollo a su manera", () => {
    const metodo = (nombre: string) =>
      familia.servings.find((s) => s.memberName === nombre)!.components.find((c) => c.id === "c-pollo")!.cookingMethod;
    expect(metodo("Francisco")).toBe("AIR_FRYER");
    expect(metodo("Sebastián")).toBe("FRIED");
    expect(metodo("Paula")).toBe("BAKED");
  });

  it("el total del pollo se agrupa por método, no en un montón indistinto", () => {
    const pollo = familia.totals.find((t) => t.label === "Pollo")!;
    const metodos = pollo.byMethod.map((g) => g.method).sort();
    expect(metodos).toEqual(["AIR_FRYER", "BAKED", "FRIED"]);
    const suma = pollo.byMethod.reduce((s, g) => s + g.quantity, 0);
    expect(suma).toBeCloseTo(pollo.total, 6);
  });
});

// ---------------------------------------------------------------------------
describe("I. grasa añadida: cuenta solo para quien la usa (§35)", () => {
  const conAceite = correr(sebastian());
  const sinAceite = correr(francisco());

  it("Francisco evita el aceite y Sebastián no", () => {
    expect(cant(sinAceite, "c-aceite")).toBe(0);
    expect(cant(conAceite, "c-aceite")).toBeGreaterThan(0);
  });

  it("la misma persona con y sin aceite difiere exactamente en el aceite", () => {
    // Se compara consigo misma: comparar a dos personas mezclaría el aceite con
    // sus distintos objetivos de proteína y no probaría nada.
    const base = sebastian();
    const conGrasa = correr(base);
    const sinGrasa = correr({ ...base, addedFatStance: "AVOID" });
    const aceiteKcal = (824 * (20 / 5)) / 100; // 4 ml por persona
    expect(kcal(conGrasa) - kcal(sinGrasa)).toBeCloseTo(aceiteKcal, 6);
    expect(cant(sinGrasa, "c-aceite")).toBe(0);
  });

  it("a Francisco se lo explican", () => {
    expect(sinAceite.reasons.some((r) => r.code === "ADDED_FAT_AVOIDED")).toBe(true);
  });

  it("evitar la grasa añadida no se lleva puesto el limón del mismo aliño", () => {
    // El limón vive en el slot de aliño junto al aceite, pero casi nada de su
    // energía viene de la grasa: no es grasa añadida y se queda.
    const LIMON: NutritionFact = {
      weightBasis: "RAW", basisUnit: "G",
      values: { energy_kcal: 29, protein_g: 1.1, carbohydrates_g: 9.3, fat_g: 0.3 },
    };
    const conLimon = receta();
    conLimon.push({
      id: "c-limon", slotId: "s-fat", label: "Limón", slotType: "FAT", quantity: 50, unit: "G",
      weightBasis: "RAW", nutrition: LIMON, cookingMethod: null, adjustability: "OPTIONAL",
      minQuantity: 0, maxQuantity: 100, ingredientId: "ing-limon", categoryId: "cat-frutas",
      isOptional: true, role: "SEASONING",
    });

    const resultado = correr(francisco(), null, conLimon);
    expect(cant(resultado, "c-aceite")).toBe(0);
    expect(cant(resultado, "c-limon")).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("J. restricción HARD: no se sirve, ni en porción chica (§38)", () => {
  const conCerdo = () => {
    const base = receta();
    base[0] = { ...base[0]!, id: "c-cerdo", label: "Cerdo", ingredientId: ING.cerdo };
    return base;
  };
  const alergico = buildProfile({
    memberId: "m-x", memberName: "Constanza", trackingMode: "BASIC", goals: [],
    pattern: patronConAlmuerzo(),
    preferences: [{ preferenceType: "ALLERGY", targetKind: "INGREDIENT", targetId: ING.cerdo }],
    cookingPreferences: [], addedFatStance: "ALLOWED",
  });

  const resultado = correr(alergico, null, conCerdo());

  it("la receta no es compatible", () => {
    expect(resultado.fit).toBe("NOT_COMPATIBLE");
  });

  it("el ingrediente incompatible NO queda en la porción final", () => {
    expect(cant(resultado, "c-cerdo")).toBe(0);
    expect(resultado.components.every((c) => c.proposedQuantity === 0)).toBe(true);
  });

  it("no aporta nada a los totales de la familia", () => {
    const totales = preparationTotals([resultado]);
    expect(totales).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("K. preferencia SOFT: anota, no prohíbe (§12)", () => {
  const conCerdo = () => {
    const base = receta();
    base[0] = { ...base[0]!, id: "c-cerdo", label: "Cerdo", ingredientId: ING.cerdo };
    return base;
  };
  const resultado = correr(sebastian(), null, conCerdo());

  it("el ingrediente sigue en la porción", () => {
    expect(cant(resultado, "c-cerdo")).toBeGreaterThan(0);
    expect(resultado.fit).not.toBe("NOT_COMPATIBLE");
  });

  it("queda anotado y explicado", () => {
    expect(resultado.reasons.some((r) => r.code === "SOFT_PREFERENCE")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("L y M. la porción declara de qué versiones salió (§46)", () => {
  const resultado = correr(francisco());

  it("referencia la versión exacta de la receta", () => {
    expect(resultado.versionId).toBe("v-1");
  });

  it("referencia la versión del perfil y del optimizador", () => {
    expect(resultado.profileVersion).toBe(francisco().version);
    expect(resultado.optimizerVersion).toMatch(/^portion-optimizer\//);
  });

  it("el perfil tiene huella estable: mismas entradas, misma huella", () => {
    expect(francisco().inputSignature).toBe(francisco().inputSignature);
    expect(signature({ a: 1, b: 2 })).toBe(signature({ b: 2, a: 1 }));
  });

  it("cambiar un objetivo cambia la huella (§17)", () => {
    expect(sebastian(60).inputSignature).not.toBe(sebastian(90).inputSignature);
  });
});

// ---------------------------------------------------------------------------
describe("N. nutrición parcial: sigue siendo parcial en la porción (§30)", () => {
  const resultado = correr(francisco());

  it("el fósforo queda PARTIAL porque el arroz no lo informa", () => {
    expect(resultado.nutrition.completeness.phosphorus_mg).toBe("PARTIAL");
    expect(resultado.nutrition.completeness.energy_kcal).toBe("COMPLETE");
  });

  it("un desconocido nunca se convierte en cero", () => {
    expect(resultado.nutrition.completeness.potassium_mg).toBe("UNKNOWN");
    expect(resultado.nutrition.values.potassium_mg).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("O. totales familiares: la suma cuadra exactamente (§33)", () => {
  const familia = projectFamilyServings({
    versionId: "v-1", components: receta(), baseServings: 5, mealType: "LUNCH",
    members: [{ profile: francisco() }, { profile: sebastian() }, { profile: paula() }],
  });

  it("el total de cada ingrediente es la suma de las porciones", () => {
    for (const total of familia.totals) {
      const suma = total.perMember.reduce((s, m) => s + m.quantity, 0);
      expect(total.total).toBeCloseTo(suma, 9);
    }
  });

  it("el total NO es la receta multiplicada por personas", () => {
    const pollo = familia.totals.find((t) => t.label === "Pollo")!;
    expect(pollo.total).not.toBeCloseTo((900 / 5) * 3, 3);
    expect(pollo.perMember).toHaveLength(3);
  });

  it("cada persona aparece una sola vez por ingrediente", () => {
    for (const total of familia.totals) {
      const nombres = total.perMember.map((m) => m.memberName);
      expect(new Set(nombres).size).toBe(nombres.length);
    }
  });
});

// ---------------------------------------------------------------------------
describe("determinismo (§47)", () => {
  it("mismos inputs, mismo output", () => {
    const a = correr(francisco());
    const b = correr(francisco());
    expect(JSON.stringify(a.components.map((c) => c.proposedQuantity))).toBe(
      JSON.stringify(b.components.map((c) => c.proposedQuantity)),
    );
    expect(a.score).toBe(b.score);
    expect(a.reasons.map((r) => r.code)).toEqual(b.reasons.map((r) => r.code));
  });
});
