import { describe, expect, it } from "vitest";
import { assessClinical, labRecency } from "./engine";
import { biomarkerSeries } from "./trends";
import { nutritionDataConfidence } from "./confidence";
import type { ClinicalAssessmentInput, ClinicalRestriction } from "./types";

/**
 * ClinicalRulesEngine — los casos que el director exige (§66-§74) más los
 * bordes de UNKNOWN. El motor es puro: acá se prueba TODA su semántica.
 */

const HOY = "2026-08-25";

function restriccion(partial: Partial<ClinicalRestriction> = {}): ClinicalRestriction {
  return {
    id: "r-1",
    type: "NUTRIENT_MAX",
    target: "phosphorus_mg",
    value: 500,
    unit: "mg",
    severity: "HARD",
    source: "USER_CONFIRMED_LIMIT",
    ruleVersionId: "rv-1",
    requiredBiomarkers: [],
    validFrom: "2026-08-01",
    validUntil: null,
    ...partial,
  };
}

function entrada(partial: Partial<ClinicalAssessmentInput> = {}): ClinicalAssessmentInput {
  return {
    date: HOY,
    // Por defecto: la porción de la persona. Los casos de screening lo dicen.
    nutritionSource: "PROJECTED_MEMBER_SERVING",
    restrictions: [restriccion()],
    observations: [],
    schedules: [],
    nutrition: {
      values: { phosphorus_mg: 400 },
      completeness: { phosphorus_mg: "COMPLETE" },
    },
    ingredientIds: [],
    categoryIds: [],
    quantitiesByIngredient: {},
    ...partial,
  };
}

describe("§66 — el caso demo del director (Nutrient X max = 500)", () => {
  it("Receta A: 400 COMPLETO → COMPATIBLE, con la regla citada", () => {
    const a = assessClinical(entrada());
    expect(a.status).toBe("COMPATIBLE");
    expect(a.reasons.some((r) => r.code === "RESTRICTION_OK")).toBe(true);
    expect(a.ruleRefs).toEqual([{ restrictionId: "r-1", ruleVersionId: "rv-1" }]);
    // El techo HARD viaja al optimizador aunque hoy cumpla (§31).
    expect(a.proposedAdjustments).toEqual([
      { kind: "NUTRIENT_CEILING", nutrient: "phosphorus_mg", max: 500, restrictionId: "r-1" },
    ]);
  });

  it("Receta B: 650 COMPLETO → CLINICALLY_INVALIDATED con violación", () => {
    const a = assessClinical(
      entrada({ nutrition: { values: { phosphorus_mg: 650 }, completeness: { phosphorus_mg: "COMPLETE" } } }),
    );
    expect(a.status).toBe("CLINICALLY_INVALIDATED");
    expect(a.violations).toHaveLength(1);
    expect(a.reasons.find((r) => r.code === "NUTRIENT_OVER_MAX")).toBeDefined();
  });

  it("Receta C: nutrient UNKNOWN → REVIEW_REQUIRED, jamás compatible", () => {
    const a = assessClinical(
      entrada({ nutrition: { values: {}, completeness: {} } }),
    );
    expect(a.status).toBe("REVIEW_REQUIRED");
    expect(a.missingData).toEqual([
      { kind: "NUTRIENT", target: "phosphorus_mg", detail: "completeness UNKNOWN" },
    ]);
    expect(a.reasons[0]!.text).toContain("No contamos con información completa");
  });
});

describe("§27/§72 — PARTIAL nunca es 0", () => {
  it("PARTIAL bajo el techo → REVIEW_REQUIRED (lo que falta solo puede sumar)", () => {
    const a = assessClinical(
      entrada({ nutrition: { values: { phosphorus_mg: 300 }, completeness: { phosphorus_mg: "PARTIAL" } } }),
    );
    expect(a.status).toBe("REVIEW_REQUIRED");
  });

  it("PARTIAL que YA excede el techo → CLINICALLY_INVALIDATED (peor que no saber)", () => {
    const a = assessClinical(
      entrada({ nutrition: { values: { phosphorus_mg: 620 }, completeness: { phosphorus_mg: "PARTIAL" } } }),
    );
    expect(a.status).toBe("CLINICALLY_INVALIDATED");
  });

  it("NUTRIENT_MIN asimétrico: PARTIAL que ya cumple el mínimo ES aceptable", () => {
    const a = assessClinical(
      entrada({
        restrictions: [restriccion({ type: "NUTRIENT_MIN", target: "protein_g", value: 20, unit: "g" })],
        nutrition: { values: { protein_g: 30 }, completeness: { protein_g: "PARTIAL" } },
      }),
    );
    expect(a.status).toBe("COMPATIBLE");
  });
});

describe("unidades del límite (§7 aplicado a reglas)", () => {
  it("límite en otra unidad que el catálogo → REVIEW, sin conversión inventada", () => {
    const a = assessClinical(
      entrada({ restrictions: [restriccion({ unit: "mmol" })] }),
    );
    expect(a.status).toBe("REVIEW_REQUIRED");
    expect(a.reasons[0]!.code).toBe("UNIT_MISMATCH");
  });
});

describe("§69/§71 — insumos de laboratorio", () => {
  const conLab = (obs: ClinicalAssessmentInput["observations"], schedules: ClinicalAssessmentInput["schedules"] = []) =>
    entrada({
      restrictions: [restriccion({ requiredBiomarkers: [{ code: "potassium", maxAgeDays: 90 }] })],
      observations: obs,
      schedules,
    });

  it("§29: biomarcador requerido AUSENTE → REVIEW + MISSING_REQUIRED_DATA", () => {
    const a = assessClinical(conLab([]));
    expect(a.status).toBe("REVIEW_REQUIRED");
    expect(a.missingData).toEqual([{ kind: "BIOMARKER", target: "potassium", detail: "sin resultado confirmado" }]);
  });

  it("§69: valor con unidad DESCONOCIDA → REVIEW, la regla no corre", () => {
    const a = assessClinical(
      conLab([{ id: "o1", biomarkerCode: "potassium", value: 4.5, unit: null, collectedDate: "2026-08-20" }]),
    );
    expect(a.status).toBe("REVIEW_REQUIRED");
    expect(a.reasons[0]!.code).toBe("LAB_UNIT_UNKNOWN");
    // La observación igual queda citada: se usó para DECIDIR que no se puede.
    expect(a.observationRefs).toEqual(["o1"]);
  });

  it("§71: último examen OUTDATED → REVIEW, no se recicla como vigente", () => {
    const a = assessClinical(
      conLab([{ id: "o2", biomarkerCode: "potassium", value: 4.5, unit: "mmol/L", collectedDate: "2026-01-10" }]),
    );
    expect(a.status).toBe("REVIEW_REQUIRED");
    expect(a.reasons[0]!.code).toBe("LAB_OUTDATED");
  });

  it("examen vigente con unidad → la regla corre y evalúa el nutriente", () => {
    const a = assessClinical(
      conLab([{ id: "o3", biomarkerCode: "potassium", value: 4.5, unit: "mmol/L", collectedDate: "2026-08-10" }]),
    );
    expect(a.status).toBe("COMPATIBLE");
  });
});

describe("exclusiones y porciones", () => {
  it("§73: INGREDIENT_EXCLUDE HARD gana aunque el alimento sea FAVORITE", () => {
    // La preferencia ni siquiera entra al motor clínico: la exclusión
    // confirmada invalida y punto — la prioridad es estructural.
    const a = assessClinical(
      entrada({
        restrictions: [restriccion({ type: "INGREDIENT_EXCLUDE", target: "ing-x", value: null, unit: null })],
        ingredientIds: ["ing-x", "ing-otro"],
      }),
    );
    expect(a.status).toBe("CLINICALLY_INVALIDATED");
  });

  it("CATEGORY_EXCLUDE CAUTION presente → COMPATIBLE_WITH_CAUTION", () => {
    const a = assessClinical(
      entrada({
        restrictions: [restriccion({ type: "CATEGORY_EXCLUDE", target: "cat-y", severity: "CAUTION", value: null, unit: null })],
        categoryIds: ["cat-y"],
      }),
    );
    expect(a.status).toBe("COMPATIBLE_WITH_CAUTION");
  });

  it("PORTION_MAX con cantidad conocida que excede → invalida", () => {
    const a = assessClinical(
      entrada({
        restrictions: [restriccion({ type: "PORTION_MAX", target: "ing-z", value: 100, unit: "g" })],
        ingredientIds: ["ing-z"],
        quantitiesByIngredient: { "ing-z": 150 },
      }),
    );
    expect(a.status).toBe("CLINICALLY_INVALIDATED");
  });

  it("PORTION_MAX presente pero SIN cantidad conocida → REVIEW, no se adivina", () => {
    const a = assessClinical(
      entrada({
        restrictions: [restriccion({ type: "PORTION_MAX", target: "ing-z", value: 100, unit: "g" })],
        ingredientIds: ["ing-z"],
        quantitiesByIngredient: {},
      }),
    );
    expect(a.status).toBe("REVIEW_REQUIRED");
  });
});

describe("vigencia de la restricción y determinismo", () => {
  it("una restricción fuera de vigencia NO participa", () => {
    const a = assessClinical(
      entrada({
        restrictions: [restriccion({ validUntil: "2026-08-20" })],
        nutrition: { values: { phosphorus_mg: 900 }, completeness: { phosphorus_mg: "COMPLETE" } },
      }),
    );
    expect(a.status).toBe("COMPATIBLE");
    expect(a.ruleRefs).toHaveLength(0);
  });

  it("mismas entradas → misma salida, byte a byte", () => {
    const i = entrada({ observations: [{ id: "o", biomarkerCode: "x", value: 1, unit: "u", collectedDate: HOY }] });
    expect(JSON.stringify(assessClinical(i))).toBe(JSON.stringify(assessClinical(i)));
  });

  it("REVIEW_REQUIRED type siempre exige ojo humano", () => {
    const a = assessClinical(
      entrada({ restrictions: [restriccion({ type: "REVIEW_REQUIRED", target: "dieta especial", value: null, unit: null })] }),
    );
    expect(a.status).toBe("REVIEW_REQUIRED");
  });
});

describe("labRecency (§14) — la vigencia jamás se inventa", () => {
  const obs = [{ id: "o1", biomarkerCode: "egfr", value: 60, unit: "mL/min", collectedDate: "2026-06-01" }];

  it("sin frecuencia configurada → NO_SCHEDULE_CONFIGURED, no un plazo inventado", () => {
    expect(labRecency("egfr", HOY, obs, []).status).toBe("NO_SCHEDULE_CONFIGURED");
  });

  it("sin resultado → MISSING", () => {
    expect(labRecency("uacr", HOY, obs, []).status).toBe("MISSING");
  });

  it("con frecuencia del DOCTOR: CURRENT / EXPIRING_SOON / OUTDATED", () => {
    const sched = [{ biomarkerCode: "egfr", intervalDays: 90, source: "DOCTOR" }];
    expect(labRecency("egfr", "2026-06-20", obs, sched).status).toBe("CURRENT");
    expect(labRecency("egfr", "2026-08-18", obs, sched).status).toBe("EXPIRING_SOON");
    expect(labRecency("egfr", "2026-09-15", obs, sched).status).toBe("OUTDATED");
  });
});

describe("tendencias (§12/§13) — descriptivas, series por unidad", () => {
  it("unidades distintas = series separadas, jamás mezcladas", () => {
    const series = biomarkerSeries(
      [
        { id: "a", biomarkerCode: "glucose", value: 100, unit: "mg/dL", collectedDate: "2026-05-01" },
        { id: "b", biomarkerCode: "glucose", value: 5.5, unit: "mmol/L", collectedDate: "2026-06-01" },
        { id: "c", biomarkerCode: "glucose", value: 105, unit: "mg/dL", collectedDate: "2026-07-01" },
      ],
      "glucose",
    );
    expect(series).toHaveLength(2);
    expect(series.map((s) => s.unit).sort()).toEqual(["mg/dL", "mmol/L"]);
  });

  it("tendencia ascendente con 3+ subidas consecutivas; comparación con la anterior", () => {
    const [s] = biomarkerSeries(
      [
        { id: "a", biomarkerCode: "hba1c", value: 5.6, unit: "%", collectedDate: "2026-02-01" },
        { id: "b", biomarkerCode: "hba1c", value: 5.8, unit: "%", collectedDate: "2026-04-01" },
        { id: "c", biomarkerCode: "hba1c", value: 6.0, unit: "%", collectedDate: "2026-06-01" },
      ],
      "hba1c",
    );
    expect(s!.trend).toBe("ASCENDENTE");
    expect(s!.lastComparison).toBe("MAYOR");
  });
});

describe("NutritionDataConfidence (§17) — sobre los DATOS, no la salud", () => {
  it("todo vigente → HIGH con razón positiva", () => {
    const c = nutritionDataConfidence({
      date: HOY,
      restrictions: [restriccion({ requiredBiomarkers: [{ code: "potassium", maxAgeDays: 90 }] })],
      observations: [{ id: "o", biomarkerCode: "potassium", value: 4.2, unit: "mmol/L", collectedDate: "2026-08-10" }],
      schedules: [],
      unverifiedObservationCount: 0,
      pendingImpactReviews: 0,
    });
    expect(c.level).toBe("HIGH");
  });

  it("biomarcador exigido FALTANTE → LOW, con la razón exacta", () => {
    const c = nutritionDataConfidence({
      date: HOY,
      restrictions: [restriccion({ requiredBiomarkers: [{ code: "potassium", maxAgeDays: 90 }] })],
      observations: [],
      schedules: [],
      unverifiedObservationCount: 2,
      pendingImpactReviews: 0,
    });
    expect(c.level).toBe("LOW");
    expect(c.reasons.map((r) => r.code)).toContain("LAB_MISSING");
    expect(c.reasons.map((r) => r.code)).toContain("UNVERIFIED_DATA");
  });
});

// ---------------------------------------------------------------------------
// Cierre v2 §1 — nutrition_source: un estimado JAMÁS declara segura una
// porción individual. Los cuatro casos A-D que exige el director.
// ---------------------------------------------------------------------------

describe("§1 — RECIPE_BASE_ESTIMATE es screening, no veredicto", () => {
  it("A. estimado APARENTEMENTE dentro de un máximo HARD → NO hay falso COMPATIBLE", () => {
    const a = assessClinical(
      entrada({
        nutritionSource: "RECIPE_BASE_ESTIMATE",
        nutrition: { values: { phosphorus_mg: 400 }, completeness: { phosphorus_mg: "COMPLETE" } },
      }),
    );
    expect(a.status).toBe("REVIEW_REQUIRED");
    expect(a.status).not.toBe("COMPATIBLE");
    const razon = a.reasons.find((r) => r.code === "SCREENING_ONLY")!;
    expect(razon.text).toContain("PRELIMINAR");
    expect(a.nutritionSource).toBe("RECIPE_BASE_ESTIMATE");
  });

  it("B. PROJECTED_MEMBER_SERVING dentro del límite → COMPATIBLE (es SU porción)", () => {
    const a = assessClinical(
      entrada({
        nutritionSource: "PROJECTED_MEMBER_SERVING",
        nutrition: { values: { phosphorus_mg: 400 }, completeness: { phosphorus_mg: "COMPLETE" } },
      }),
    );
    expect(a.status).toBe("COMPATIBLE");
    expect(a.nutritionSource).toBe("PROJECTED_MEMBER_SERVING");
  });

  it("C. CONFIRMED_MEMBER_SERVING que EXCEDE → CLINICALLY_INVALIDATED", () => {
    const a = assessClinical(
      entrada({
        nutritionSource: "CONFIRMED_MEMBER_SERVING",
        nutrition: { values: { phosphorus_mg: 650 }, completeness: { phosphorus_mg: "COMPLETE" } },
      }),
    );
    expect(a.status).toBe("CLINICALLY_INVALIDATED");
    expect(a.violations).toHaveLength(1);
  });

  it("D. porción individual con nutrición PARTIAL → REVIEW_REQUIRED", () => {
    const a = assessClinical(
      entrada({
        nutritionSource: "CONFIRMED_MEMBER_SERVING",
        nutrition: { values: { phosphorus_mg: 300 }, completeness: { phosphorus_mg: "PARTIAL" } },
      }),
    );
    expect(a.status).toBe("REVIEW_REQUIRED");
  });

  it("el estimado que YA excede sigue invalidando: eso no es falsa seguridad", () => {
    const a = assessClinical(
      entrada({
        nutritionSource: "RECIPE_BASE_ESTIMATE",
        nutrition: { values: { phosphorus_mg: 900 }, completeness: { phosphorus_mg: "COMPLETE" } },
      }),
    );
    expect(a.status).toBe("CLINICALLY_INVALIDATED");
  });

  it("severidad CAUTION sobre estimado → con precaución, no revisión completa", () => {
    const a = assessClinical(
      entrada({
        nutritionSource: "RECIPE_BASE_ESTIMATE",
        restrictions: [restriccion({ severity: "CAUTION" })],
        nutrition: { values: { phosphorus_mg: 400 }, completeness: { phosphorus_mg: "COMPLETE" } },
      }),
    );
    expect(a.status).toBe("COMPATIBLE_WITH_CAUTION");
  });

  it("una EXCLUSIÓN no depende de la cantidad: el estimado basta para invalidar", () => {
    const a = assessClinical(
      entrada({
        nutritionSource: "RECIPE_BASE_ESTIMATE",
        restrictions: [restriccion({ type: "INGREDIENT_EXCLUDE", target: "ing-x", value: null, unit: null })],
        ingredientIds: ["ing-x"],
      }),
    );
    expect(a.status).toBe("CLINICALLY_INVALIDATED");
  });

  it("una exclusión AUSENTE con estimado sigue siendo COMPATIBLE (no aplica screening)", () => {
    const a = assessClinical(
      entrada({
        nutritionSource: "RECIPE_BASE_ESTIMATE",
        restrictions: [restriccion({ type: "INGREDIENT_EXCLUDE", target: "ing-x", value: null, unit: null })],
        ingredientIds: ["ing-otro"],
      }),
    );
    expect(a.status).toBe("COMPATIBLE");
  });

  it("PORTION_MAX HARD sobre estimado → revisión, no compatible", () => {
    const a = assessClinical(
      entrada({
        nutritionSource: "RECIPE_BASE_ESTIMATE",
        restrictions: [restriccion({ type: "PORTION_MAX", target: "ing-z", value: 200, unit: "g" })],
        ingredientIds: ["ing-z"],
        quantitiesByIngredient: { "ing-z": 150 },
      }),
    );
    expect(a.status).toBe("REVIEW_REQUIRED");
  });
});
