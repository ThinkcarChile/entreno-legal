import { describe, expect, it } from "vitest";
import type { NutritionFact } from "../catalog/types";
import { buildProfile } from "../nutrition/profile";
import type { MemberNutritionProfile } from "../nutrition/types";
import { optimizePortion, type PortionComponent } from "./optimizer";
import { preparationTotals, projectFamilyServings } from "./family";

/**
 * QA adversarial del Sprint 4. Estos tests NO buscan demostrar que funciona:
 * buscan las situaciones donde el motor entregaría una porción incorrecta.
 */

const F = (kcal: number, protein: number, fat = 0): NutritionFact => ({
  weightBasis: "RAW",
  basisUnit: "G",
  values: { energy_kcal: kcal, protein_g: protein, carbohydrates_g: 0, fat_g: fat },
});

const POLLO = F(110, 23, 1.8);
const ARROZ = F(360, 6.6, 0.6);
const LECHUGA = F(15, 1.4, 0.2);

let n = 0;
function comp(over: Partial<PortionComponent> = {}): PortionComponent {
  n += 1;
  return {
    id: `c${n}`,
    slotId: `s${n}`,
    label: `Componente ${n}`,
    slotType: "PROTEIN",
    quantity: 400,
    unit: "G",
    weightBasis: "RAW",
    nutrition: POLLO,
    cookingMethod: "BAKED",
    adjustability: "ADJUSTABLE",
    role: "MAIN",
    minQuantity: null,
    maxQuantity: null,
    ingredientId: `ing${n}`,
    categoryId: null,
    isOptional: false,
    ...over,
  };
}

function perfil(over: Partial<Parameters<typeof buildProfile>[0]> = {}): MemberNutritionProfile {
  return buildProfile({
    memberId: "m",
    memberName: "Prueba",
    trackingMode: "FULL",
    goals: [],
    pattern: {
      usesFastingPattern: false,
      firstMealType: null,
      feedingWindowStart: null,
      feedingWindowEnd: null,
      meals: [
        { mealType: "LUNCH", availability: "ENABLED", isFirstMeal: true, saladPreference: "NEUTRAL", priority: 10 },
      ],
    },
    preferences: [],
    cookingPreferences: [],
    addedFatStance: "ALLOWED",
    ...over,
  });
}

const correr = (components: PortionComponent[], profile: MemberNutritionProfile, servings = 4) =>
  optimizePortion({ versionId: "v", components, baseServings: servings, profile, mealType: "LUNCH" });

const kcal = (r: ReturnType<typeof correr>) => r.nutrition.values.energy_kcal ?? 0;
const q = (r: ReturnType<typeof correr>, id: string) =>
  r.components.find((c) => c.id === id)!.proposedQuantity;

const objetivoProteina = (min: number | null, pref: number | null, max: number | null) => ({
  goalType: "PROTEIN_G" as const, scope: "PER_MEAL" as const, mealType: "LUNCH" as const,
  minimum: min, preferred: pref, maximum: max, priority: 10,
});
const objetivoKcal = (max: number) => ({
  goalType: "ENERGY_KCAL" as const, scope: "PER_MEAL" as const, mealType: "LUNCH" as const,
  minimum: null, preferred: null, maximum: max, priority: 20,
});

// ---------------------------------------------------------------------------
describe("§5 receta SIN slot de proteína y objetivo alto", () => {
  const soloCarbo = [comp({ id: "arroz", label: "Arroz", slotType: "CARBOHYDRATE", nutrition: ARROZ, quantity: 400 })];
  const resultado = correr(soloCarbo, perfil({ goals: [objetivoProteina(60, 70, 90)] }));

  it("no puede cumplirlo y lo dice", () => {
    expect(resultado.fit).toBe("TARGET_CONFLICT");
    expect(resultado.unmetConstraints).toContain("PROTEIN_MIN");
  });

  it("NO infla el arroz para fingir proteína", () => {
    expect(q(resultado, "arroz")).toBe(100); // 400/4, sin tocar
  });

  it("no inventa un componente de proteína", () => {
    expect(resultado.components).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("§6 receta SIN carbohidrato: no se asume que exista para recortar", () => {
  const proteinaYEnsalada = [
    comp({ id: "pollo", label: "Pollo", slotType: "PROTEIN", quantity: 800, minQuantity: 400, maxQuantity: 1200 }),
    comp({ id: "lechuga", label: "Lechuga", slotType: "SALAD", nutrition: LECHUGA, quantity: 400, minQuantity: 200, maxQuantity: 600 }),
  ];
  const resultado = correr(proteinaYEnsalada, perfil({ goals: [objetivoProteina(30, 35, 60), objetivoKcal(180)] }));

  it("cumple el techo recortando lo que existe, sin romperse", () => {
    expect(kcal(resultado)).toBeLessThanOrEqual(180.5);
  });

  it("recorta la proteína antes que la ensalada", () => {
    expect(q(resultado, "pollo")).toBeLessThan(200);
    expect(q(resultado, "lechuga")).toBeGreaterThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
describe("§7 prefiere ensalada pero la receta no tiene", () => {
  const sinEnsalada = [comp({ id: "pollo", label: "Pollo", quantity: 800 })];
  const conPreferencia = perfil({
    goals: [objetivoProteina(30, 40, 60)],
    pattern: {
      usesFastingPattern: false, firstMealType: null, feedingWindowStart: null, feedingWindowEnd: null,
      meals: [{ mealType: "LUNCH", availability: "ENABLED", isFirstMeal: true, saladPreference: "PREFERRED", priority: 10 }],
    },
  });
  const resultado = correr(sinEnsalada, conPreferencia);

  it("NO inventa gramos de ensalada", () => {
    expect(resultado.components).toHaveLength(1);
    expect(resultado.components.every((c) => c.slotType !== "SALAD")).toBe(true);
  });

  it("no genera una razón de ensalada que no existe", () => {
    expect(resultado.reasons.some((r) => r.code === "SALAD_PREFERENCE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("§8 y §9 aliño mixto: solo se va la grasa AÑADIDA declarada", () => {
  const aliñoMixto = () => [
    comp({ id: "pollo", label: "Pollo", quantity: 800, minQuantity: 400, maxQuantity: 1200 }),
    comp({ id: "aceite", label: "Aceite", slotType: "FAT", role: "ADDED_FAT", adjustability: "OPTIONAL",
      isOptional: true, quantity: 40, minQuantity: 0, maxQuantity: 80, nutrition: F(824, 0, 91.6) }),
    comp({ id: "limon", label: "Limón", slotType: "FAT", role: "SEASONING", adjustability: "OPTIONAL",
      isOptional: true, quantity: 40, minQuantity: 0, maxQuantity: 80, nutrition: F(29, 1.1, 0.3) }),
    comp({ id: "hierbas", label: "Hierbas", slotType: "FAT", role: "SEASONING", adjustability: "OPTIONAL",
      isOptional: true, quantity: 8, minQuantity: 0, maxQuantity: 20, nutrition: F(23, 2.1, 0.5) }),
  ];
  const evita = perfil({ goals: [objetivoProteina(30, 40, 60)], addedFatStance: "AVOID" });
  const resultado = correr(aliñoMixto(), evita);

  it("el aceite se va", () => {
    expect(q(resultado, "aceite")).toBe(0);
  });

  it("el limón y las hierbas se quedan", () => {
    expect(q(resultado, "limon")).toBeGreaterThan(0);
    expect(q(resultado, "hierbas")).toBeGreaterThan(0);
  });

  it("los ocho alimentos del catálogo se clasifican por rol, no por macros", () => {
    // Estos son exactamente los casos que rompían la heurística del 70 %.
    const casos: [string, NutritionFact, PortionComponent["role"], boolean][] = [
      ["Aceite de oliva", F(824, 0, 91.6), "ADDED_FAT", true],
      ["Mantequilla", F(717, 0.9, 81), "ADDED_FAT", true],
      ["Mayonesa", F(680, 1, 75), "ADDED_FAT", true],
      ["Palta", F(160, 2, 14.7), "MAIN", false],
      ["Queso gouda", F(356, 25, 27.4), "MAIN", false],
      ["Yogur natural", F(61, 3.5, 3.3), "MAIN", false],
      ["Limón", F(29, 1.1, 0.3), "SEASONING", false],
      ["Semillas de girasol", F(584, 20.8, 51), "MAIN", false],
    ];

    for (const [label, fact, role, deberiaIrse] of casos) {
      const receta = [
        comp({ id: "pollo", label: "Pollo", quantity: 800, minQuantity: 400, maxQuantity: 1200 }),
        comp({ id: "x", label, slotType: "FAT", role, adjustability: "OPTIONAL", isOptional: true,
          quantity: 40, minQuantity: 0, maxQuantity: 80, nutrition: fact }),
      ];
      const r = correr(receta, evita);
      expect(q(r, "x") === 0, `${label} (rol ${role})`).toBe(deberiaIrse);
    }
  });
});

// ---------------------------------------------------------------------------
describe("§10 restricción HARD, incluso con 1 g", () => {
  const alergico = perfil({
    preferences: [{ preferenceType: "ALLERGY", targetKind: "INGREDIENT", targetId: "ing-mani" }],
  });

  for (const cantidad of [1, 400]) {
    it(`${cantidad} g del ingrediente prohibido sigue prohibido`, () => {
      const receta = [
        comp({ id: "pollo", label: "Pollo", quantity: 800 }),
        comp({ id: "mani", label: "Maní", quantity: cantidad, ingredientId: "ing-mani",
          slotType: "TOPPING", adjustability: "OPTIONAL", isOptional: true }),
      ];
      const r = correr(receta, alergico);
      expect(r.fit).toBe("NOT_COMPATIBLE");
      expect(q(r, "mani")).toBe(0);
      expect(preparationTotals([r])).toHaveLength(0);
    });
  }

  it("una restricción por CATEGORÍA también bloquea", () => {
    const porCategoria = perfil({
      preferences: [{ preferenceType: "MEDICAL_RESTRICTION", targetKind: "CATEGORY", targetId: "cat-mariscos" }],
    });
    const receta = [comp({ id: "camaron", label: "Camarón", categoryId: "cat-mariscos" })];
    expect(correr(receta, porCategoria).fit).toBe("NOT_COMPATIBLE");
  });
});

// ---------------------------------------------------------------------------
describe("§11 SOFT dislike: elegible, anotado, jamás tratado como alergia", () => {
  const conDislike = perfil({
    goals: [objetivoProteina(30, 40, 60)],
    preferences: [{ preferenceType: "DISLIKE", targetKind: "INGREDIENT", targetId: "ing-cerdo" }],
  });
  const receta = [comp({ id: "cerdo", label: "Cerdo", quantity: 800, ingredientId: "ing-cerdo" })];
  const r = correr(receta, conDislike);

  it("sigue siendo elegible", () => {
    expect(r.fit).not.toBe("NOT_COMPATIBLE");
    expect(q(r, "cerdo")).toBeGreaterThan(0);
  });

  it("baja el puntaje pero no prohíbe", () => {
    const sinDislike = correr(receta, perfil({ goals: [objetivoProteina(30, 40, 60)] }));
    expect(r.reasons.some((x) => x.code === "SOFT_PREFERENCE")).toBe(true);
    expect(sinDislike.reasons.some((x) => x.code === "SOFT_PREFERENCE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("§12 jerarquía de preferencias de cocción", () => {
  const jerarquia = perfil({
    cookingPreferences: [
      { ingredientId: null, categoryId: null, cookingMethod: "BAKED", stance: "PREFERRED" },
      { ingredientId: null, categoryId: "cat-pescados", cookingMethod: "AIR_FRYER", stance: "PREFERRED" },
      { ingredientId: "ing-salmon", categoryId: null, cookingMethod: "POACHED", stance: "PREFERRED" },
    ],
  });

  const metodo = (id: string, categoryId: string | null) => {
    const receta = [comp({ id: "x", ingredientId: id, categoryId, cookingMethod: "GRILLED" })];
    return correr(receta, jerarquia).components[0]!.cookingMethod;
  };

  it("el ingrediente específico gana: salmón queda pochado", () => {
    expect(metodo("ing-salmon", "cat-pescados")).toBe("POACHED");
  });

  it("la categoría gana sobre lo global: pescado blanco al air fryer", () => {
    expect(metodo("ing-merluza", "cat-pescados")).toBe("AIR_FRYER");
  });

  it("sin regla más específica manda lo global: pollo al horno", () => {
    expect(metodo("ing-pollo", "cat-aves")).toBe("BAKED");
  });
});

// ---------------------------------------------------------------------------
describe("§18 y §19 límites: nada de 2 kg de pollo para cuadrar un objetivo", () => {
  it("un objetivo absurdo respeta el máximo del componente", () => {
    const receta = [comp({ id: "pollo", label: "Pollo", quantity: 800, minQuantity: 400, maxQuantity: 1200 })];
    const r = correr(receta, perfil({ goals: [objetivoProteina(400, 500, null)] }));
    expect(q(r, "pollo")).toBeLessThanOrEqual(1200 / 4);
    expect(r.fit).toBe("TARGET_CONFLICT");
  });

  it("sin límites declarados usa un margen conservador y lo dice", () => {
    const receta = [comp({ id: "pollo", label: "Pollo", quantity: 800, minQuantity: null, maxQuantity: null })];
    const r = correr(receta, perfil({ goals: [objetivoProteina(400, 500, null)] }));
    expect(q(r, "pollo")).toBeLessThanOrEqual((800 / 4) * 2 + 1e-6);
    expect(r.reasons.some((x) => x.code === "MISSING_ADJUSTMENT_LIMITS")).toBe(true);
  });

  it("el mínimo se respeta al recortar calorías", () => {
    const receta = [
      comp({ id: "pollo", label: "Pollo", quantity: 800, minQuantity: 600, maxQuantity: 1000 }),
      comp({ id: "arroz", label: "Arroz", slotType: "CARBOHYDRATE", nutrition: ARROZ, quantity: 400, minQuantity: 300, maxQuantity: 500 }),
    ];
    const r = correr(receta, perfil({ goals: [objetivoKcal(50)] }));
    expect(q(r, "pollo")).toBeGreaterThanOrEqual(600 / 4 - 1e-6);
    expect(q(r, "arroz")).toBeGreaterThanOrEqual(300 / 4 - 1e-6);
    expect(r.fit).toBe("TARGET_CONFLICT"); // no se puede, y se dice
  });

  it("un componente FIXED no se toca ni para cuadrar calorías", () => {
    const receta = [
      comp({ id: "sal", label: "Sal", slotType: "SEASONING" as never, adjustability: "FIXED", quantity: 20, nutrition: F(0, 0) }),
      comp({ id: "arroz", label: "Arroz", slotType: "CARBOHYDRATE", nutrition: ARROZ, quantity: 400, minQuantity: 100, maxQuantity: 500 }),
    ];
    const r = correr(receta, perfil({ goals: [objetivoKcal(100)] }));
    expect(q(r, "sal")).toBe(5); // 20/4 intacto
  });
});

// ---------------------------------------------------------------------------
describe("§1 y §16 totales familiares y cambio selectivo", () => {
  const receta = () => [
    comp({ id: "pollo", label: "Pollo", quantity: 800, minQuantity: 400, maxQuantity: 1600 }),
    comp({ id: "arroz", label: "Arroz", slotType: "CARBOHYDRATE", nutrition: ARROZ, quantity: 400, minQuantity: 200, maxQuantity: 600 }),
  ];

  const ana = perfil({ goals: [objetivoProteina(40, 50, 70)] });
  const beto = { ...perfil({ goals: [objetivoProteina(30, 35, 50)] }), memberId: "b", memberName: "Beto" };
  const caro = { ...perfil({ trackingMode: "OFF" }), memberId: "c", memberName: "Caro" };

  it("el total es exactamente la suma, sin doble conteo", () => {
    const familia = projectFamilyServings({
      versionId: "v", components: receta(), baseServings: 4, mealType: "LUNCH",
      members: [{ profile: { ...ana, memberId: "a", memberName: "Ana" } }, { profile: beto }, { profile: caro }],
    });
    for (const total of familia.totals) {
      const suma = total.perMember.reduce((s, m) => s + m.quantity, 0);
      expect(total.total).toBeCloseTo(suma, 9);
      expect(total.perMember).toHaveLength(3);
      const porMetodo = total.byMethod.reduce((s, g) => s + g.quantity, 0);
      expect(porMetodo).toBeCloseTo(total.total, 9);
    }
  });

  it("cambiar el objetivo de uno no mueve la porción de los otros", () => {
    const antes = projectFamilyServings({
      versionId: "v", components: receta(), baseServings: 4, mealType: "LUNCH",
      members: [{ profile: { ...ana, memberId: "a", memberName: "Ana" } }, { profile: beto }, { profile: caro }],
    });
    const betoNuevo = { ...perfil({ goals: [objetivoProteina(60, 80, 100)] }), memberId: "b", memberName: "Beto" };
    const despues = projectFamilyServings({
      versionId: "v", components: receta(), baseServings: 4, mealType: "LUNCH",
      members: [{ profile: { ...ana, memberId: "a", memberName: "Ana" } }, { profile: betoNuevo }, { profile: caro }],
    });

    const pollo = (p: typeof antes, quien: string) =>
      p.servings.find((s) => s.memberName === quien)!.components.find((c) => c.id === "pollo")!.proposedQuantity;

    expect(pollo(despues, "Beto")).toBeGreaterThan(pollo(antes, "Beto"));
    expect(pollo(despues, "Ana")).toBeCloseTo(pollo(antes, "Ana"), 9);
    expect(pollo(despues, "Caro")).toBeCloseTo(pollo(antes, "Caro"), 9);

    const totalAntes = antes.totals.find((t) => t.label === "Pollo")!.total;
    const totalDespues = despues.totals.find((t) => t.label === "Pollo")!.total;
    const deltaBeto = pollo(despues, "Beto") - pollo(antes, "Beto");
    expect(totalDespues - totalAntes).toBeCloseTo(deltaBeto, 9);
  });

  it("una huella distinta implica perfil distinto; una igual, el mismo", () => {
    expect(beto.inputSignature).not.toBe(
      perfil({ goals: [objetivoProteina(60, 80, 100)] }).inputSignature,
    );
    expect(perfil({ goals: [objetivoProteina(40, 50, 70)] }).inputSignature).toBe(ana.inputSignature);
  });
});

// ---------------------------------------------------------------------------
describe("§17 determinismo estricto", () => {
  it("diez ejecuciones idénticas dan exactamente lo mismo", () => {
    const receta = [
      comp({ id: "pollo", label: "Pollo", quantity: 800, minQuantity: 400, maxQuantity: 1200 }),
      comp({ id: "arroz", label: "Arroz", slotType: "CARBOHYDRATE", nutrition: ARROZ, quantity: 400, minQuantity: 200, maxQuantity: 600 }),
      comp({ id: "aceite", label: "Aceite", slotType: "FAT", role: "ADDED_FAT", adjustability: "OPTIONAL",
        isOptional: true, quantity: 20, minQuantity: 0, maxQuantity: 40, nutrition: F(824, 0, 91.6) }),
    ];
    const p = perfil({ goals: [objetivoProteina(45, 55, 70), objetivoKcal(600)], addedFatStance: "AVOID" });
    const salidas = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const r = correr(receta, p);
      salidas.add(JSON.stringify({
        c: r.components.map((x) => [x.id, x.proposedQuantity, x.cookingMethod, x.addedFatG]),
        fit: r.fit, score: r.score, razones: r.reasons.map((x) => [x.code, x.params]),
      }));
    }
    expect(salidas.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("§20 nutrición parcial nunca se vuelve cero", () => {
  it("un nutriente que nadie informa queda UNKNOWN con valor null", () => {
    const receta = [comp({ id: "pollo", label: "Pollo", quantity: 800 })];
    const r = correr(receta, perfil());
    expect(r.nutrition.completeness.phosphorus_mg).toBe("UNKNOWN");
    expect(r.nutrition.values.phosphorus_mg).toBeNull();
  });

  it("si uno lo informa y otro no, queda PARTIAL con la suma de lo conocido", () => {
    const receta = [
      comp({ id: "a", label: "Con fósforo", quantity: 400,
        nutrition: { weightBasis: "RAW", basisUnit: "G", values: { energy_kcal: 100, protein_g: 20, phosphorus_mg: 200 } } }),
      comp({ id: "b", label: "Sin fósforo", quantity: 400,
        nutrition: { weightBasis: "RAW", basisUnit: "G", values: { energy_kcal: 100, protein_g: 20, phosphorus_mg: null } } }),
    ];
    const r = correr(receta, perfil());
    expect(r.nutrition.completeness.phosphorus_mg).toBe("PARTIAL");
    expect(r.nutrition.values.phosphorus_mg).toBeCloseTo(200, 6); // 200 x 100/100
    expect(r.nutrition.values.phosphorus_mg).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("§26 sustitución: se propone, no se aplica sola", () => {
  const CERDO = F(242, 27, 14);
  const POLLO_ALT = F(110, 23, 1.8);

  const receta = () => [
    comp({ id: "cerdo", slotId: "s-prot", label: "Cerdo", quantity: 800,
      ingredientId: "ing-cerdo", minQuantity: 400, maxQuantity: 1200 }),
  ];
  const alternativas = [
    { slotId: "s-prot", ingredientId: "ing-pollo", label: "Pollo", nutrition: POLLO_ALT },
  ];
  const sebastian = perfil({
    goals: [objetivoProteina(40, 50, 70)],
    preferences: [{ preferenceType: "DISLIKE", targetKind: "INGREDIENT", targetId: "ing-cerdo" }],
  });

  const sinAplicar = optimizePortion({
    versionId: "v", components: receta().map((c) => ({ ...c, nutrition: CERDO })),
    baseServings: 4, profile: sebastian, mealType: "LUNCH", alternatives: alternativas,
  });

  it("propone el reemplazo", () => {
    expect(sinAplicar.suggestions).toHaveLength(1);
    expect(sinAplicar.suggestions[0]!.alternativeLabel).toBe("Pollo");
    expect(sinAplicar.suggestions[0]!.componentLabel).toBe("Cerdo");
  });

  it("pero NO lo aplica: el cerdo sigue en la porción", () => {
    const componente = sinAplicar.components[0]!;
    expect(componente.label).toBe("Cerdo");
    expect(componente.proposedQuantity).toBeGreaterThan(0);
  });

  it("al aceptarlo, reemplaza y vuelve a optimizar sobre el plato nuevo", () => {
    const aplicado = optimizePortion({
      versionId: "v", components: receta().map((c) => ({ ...c, nutrition: CERDO })),
      baseServings: 4, profile: sebastian, mealType: "LUNCH", alternatives: alternativas,
      substitutions: [
        { componentId: "cerdo", ingredientId: "ing-pollo", label: "Pollo", nutrition: POLLO_ALT },
      ],
    });

    expect(aplicado.components[0]!.label).toBe("Pollo");
    // El pollo tiene menos proteína por gramo: la cantidad se recalcula, no se
    // copia la del cerdo.
    expect(aplicado.components[0]!.proposedQuantity).not.toBeCloseTo(
      sinAplicar.components[0]!.proposedQuantity,
      3,
    );
    // Y ya no queda el disgusto anotado.
    expect(aplicado.reasons.some((r) => r.code === "SOFT_PREFERENCE")).toBe(false);
    expect(aplicado.reasons.some((r) => r.code === "SUBSTITUTION_SUGGESTED")).toBe(true);
  });

  it("no propone una alternativa que a la persona tampoco le gusta", () => {
    const nadaLeGusta = perfil({
      goals: [objetivoProteina(40, 50, 70)],
      preferences: [
        { preferenceType: "DISLIKE", targetKind: "INGREDIENT", targetId: "ing-cerdo" },
        { preferenceType: "DISLIKE", targetKind: "INGREDIENT", targetId: "ing-pollo" },
      ],
    });
    const r = optimizePortion({
      versionId: "v", components: receta().map((c) => ({ ...c, nutrition: CERDO })),
      baseServings: 4, profile: nadaLeGusta, mealType: "LUNCH", alternatives: alternativas,
    });
    expect(r.suggestions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("§26 y §33 un reemplazo NO se suma al total del alimento original", () => {
  const CERDO = F(242, 27, 14);
  const POLLO_ALT = F(110, 23, 1.8);

  const receta = () => [
    comp({ id: "prot", slotId: "s-prot", label: "Cerdo", quantity: 800,
      ingredientId: "ing-cerdo", nutrition: CERDO, minQuantity: 400, maxQuantity: 1200 }),
  ];
  const alternativas = [
    { slotId: "s-prot", ingredientId: "ing-pollo", label: "Pollo", nutrition: POLLO_ALT },
  ];
  const sinCambio = perfil({ goals: [objetivoProteina(40, 50, 70)] });
  const conCambio = perfil({
    goals: [objetivoProteina(40, 50, 70)],
    preferences: [{ preferenceType: "DISLIKE", targetKind: "INGREDIENT", targetId: "ing-cerdo" }],
  });

  it("cada alimento tiene su propia línea en los totales", () => {
    const familia = projectFamilyServings({
      versionId: "v", components: receta(), alternatives: alternativas, baseServings: 4, mealType: "LUNCH",
      members: [
        { profile: { ...sinCambio, memberId: "a", memberName: "Ana" } },
        {
          profile: { ...conCambio, memberId: "b", memberName: "Beto" },
          substitutions: [
            { componentId: "prot", ingredientId: "ing-pollo", label: "Pollo", nutrition: POLLO_ALT },
          ],
        },
      ],
    });

    const etiquetas = familia.totals.map((t) => t.label).sort();
    expect(etiquetas).toEqual(["Cerdo", "Pollo"]);

    const cerdo = familia.totals.find((t) => t.label === "Cerdo")!;
    const pollo = familia.totals.find((t) => t.label === "Pollo")!;
    expect(cerdo.perMember.map((m) => m.memberName)).toEqual(["Ana"]);
    expect(pollo.perMember.map((m) => m.memberName)).toEqual(["Beto"]);
  });

  it("sin reemplazos sigue siendo una sola línea", () => {
    const familia = projectFamilyServings({
      versionId: "v", components: receta(), alternatives: alternativas, baseServings: 4, mealType: "LUNCH",
      members: [
        { profile: { ...sinCambio, memberId: "a", memberName: "Ana" } },
        { profile: { ...sinCambio, memberId: "b", memberName: "Beto" } },
      ],
    });
    expect(familia.totals).toHaveLength(1);
    expect(familia.totals[0]!.perMember).toHaveLength(2);
  });
});
