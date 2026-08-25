import { describe, expect, it } from "vitest";
import { assessRefreeze, assessStorage, planThaw, recommendStorage } from "./safety";
import type { LotFacts, SafetyRule } from "./types";

const HOY = "2026-08-24";

function regla(partial: Partial<SafetyRule> = {}): SafetyRule {
  return {
    id: "r-1",
    isHousehold: false,
    ingredientId: null,
    categoryId: null,
    processingState: null,
    temperatureState: null,
    vacuumSealed: null,
    ruleKind: "STORAGE_DAYS",
    maxDays: null,
    useSoonWithinDays: 1,
    refreezeAllowed: null,
    thawFridgeHours: null,
    source: "USDA (test)",
    ...partial,
  };
}

function hechos(partial: Partial<LotFacts> = {}): LotFacts {
  return {
    ingredientId: "ing-pollo",
    categoryId: "cat-carnes",
    processingState: "RAW",
    temperatureState: "CHILLED",
    vacuumSealed: false,
    storedSince: HOY,
    ...partial,
  };
}

describe("§21/§75 — UNKNOWN jamás es SAFE", () => {
  it("sin regla que calce: SAFETY_REVIEW_REQUIRED, sin fecha inventada", () => {
    const r = assessStorage(hechos(), [], HOY);
    expect(r.verdict).toBe("SAFETY_REVIEW_REQUIRED");
    expect("safeUseBy" in r).toBe(false);
  });

  it("una regla de OTRO estado no calza: sigue siendo revisar", () => {
    const soloFrozen = regla({ temperatureState: "FROZEN" });
    const r = assessStorage(hechos({ temperatureState: "CHILLED" }), [soloFrozen], HOY);
    expect(r.verdict).toBe("SAFETY_REVIEW_REQUIRED");
  });
});

describe("STORAGE_DAYS: la fecha nace de la regla, citándola", () => {
  const pollo2dias = regla({
    ingredientId: "ing-pollo",
    processingState: "RAW",
    temperatureState: "CHILLED",
    maxDays: 2,
  });

  it("dentro de la ventana → SAFE con fecha y fuente citada", () => {
    const r = assessStorage(hechos({ storedSince: HOY }), [pollo2dias], HOY);
    expect(r).toMatchObject({ verdict: "SAFE", safeUseBy: "2026-08-26", source: "USDA (test)" });
  });

  it("SAFE lejos del borde, USE_SOON cerca, DO_NOT_RECOMMEND pasado", () => {
    const cinco = regla({ maxDays: 5, useSoonWithinDays: 1 });
    expect(assessStorage(hechos({ storedSince: HOY }), [cinco], HOY).verdict).toBe("SAFE");
    expect(assessStorage(hechos({ storedSince: "2026-08-20" }), [cinco], HOY).verdict).toBe("USE_SOON");
    expect(assessStorage(hechos({ storedSince: "2026-08-15" }), [cinco], HOY).verdict).toBe("DO_NOT_RECOMMEND");
  });

  it("maxDays null = 'seguro sin fecha' EXPLÍCITO (congelado), distinto de sin-regla", () => {
    const frozen = regla({ temperatureState: "FROZEN", maxDays: null });
    const r = assessStorage(hechos({ temperatureState: "FROZEN" }), [frozen], HOY);
    expect(r).toMatchObject({ verdict: "SAFE", safeUseBy: null });
  });
});

describe("especificidad determinista", () => {
  it("la regla del hogar vence a la global; la del ingrediente a la genérica", () => {
    const generica = regla({ id: "r-gen", maxDays: 10 });
    const delIngrediente = regla({ id: "r-ing", ingredientId: "ing-pollo", maxDays: 2 });
    const delHogar = regla({ id: "r-hogar", isHousehold: true, maxDays: 5 });
    const r = assessStorage(hechos(), [generica, delIngrediente, delHogar], HOY);
    expect(r).toMatchObject({ ruleId: "r-hogar" }); // hogar 32 > ingrediente 16
    const r2 = assessStorage(hechos(), [generica, delIngrediente], HOY);
    expect(r2).toMatchObject({ ruleId: "r-ing" });
  });

  it("empate exacto → la más restrictiva (menos días)", () => {
    const a = regla({ id: "r-a", maxDays: 7 });
    const b = regla({ id: "r-b", maxDays: 3 });
    const r = assessStorage(hechos(), [a, b], HOY);
    expect(r).toMatchObject({ ruleId: "r-b" });
  });
});

describe("§22/§74 — el vacío es EMPAQUE, no un permiso", () => {
  it("sellado al vacío sin regla específica NO gana vida útil: revisar", () => {
    // Solo existe regla para NO-vacío: el lote sellado no la puede usar.
    const soloSinVacio = regla({ vacuumSealed: false, maxDays: 2 });
    const r = assessStorage(hechos({ vacuumSealed: true }), [soloSinVacio], HOY);
    expect(r.verdict).toBe("SAFETY_REVIEW_REQUIRED");
  });

  it("vacío + temperatura ambiente sin regla ≠ shelf stable", () => {
    const chilled = regla({ temperatureState: "CHILLED", maxDays: 2 });
    const r = assessStorage(hechos({ vacuumSealed: true, temperatureState: "AMBIENT" }), [chilled], HOY);
    expect(r.verdict).toBe("SAFETY_REVIEW_REQUIRED");
  });

  it("una regla genérica (vacío = null) sí cubre al sellado — sin extenderlo", () => {
    const generica = regla({ temperatureState: "CHILLED", maxDays: 2 });
    const sellado = assessStorage(hechos({ vacuumSealed: true }), [generica], HOY);
    const suelto = assessStorage(hechos({ vacuumSealed: false }), [generica], HOY);
    expect(sellado).toEqual(suelto); // misma ventana: el vacío no regala días
  });
});

describe("§23 — refrigerar vs congelar SOLO con respaldo", () => {
  const chilled2 = regla({ id: "r-ch", processingState: "PREPPED", temperatureState: "CHILLED", maxDays: 2 });
  const frozenOk = regla({ id: "r-fr", temperatureState: "FROZEN", maxDays: null });
  const base = { ingredientId: "ing-pollo", categoryId: null, processingState: "PREPPED" as const, vacuumSealed: false, storedSince: HOY };

  it("uso dentro de la ventana refrigerada → REFRIGERATE con fuente", () => {
    const r = recommendStorage(base, "2026-08-25", [chilled2, frozenOk], HOY);
    expect(r.storage).toBe("REFRIGERATE");
    expect(r.source).toContain("USDA");
  });

  it("uso fuera de la ventana → FREEZE (hay regla de congelado)", () => {
    const r = recommendStorage(base, "2026-08-30", [chilled2, frozenOk], HOY);
    expect(r.storage).toBe("FREEZE");
  });

  it("sin reglas → REVIEW_REQUIRED, sin microbiología improvisada", () => {
    const r = recommendStorage(base, "2026-08-25", [], HOY);
    expect(r.storage).toBe("REVIEW_REQUIRED");
    expect(r.source).toBeNull();
  });
});

describe("§24/§25/§73 — recongelar jamás se simplifica", () => {
  const reglaRefreeze = regla({ id: "r-ref", ruleKind: "REFREEZE", temperatureState: "CHILLED", refreezeAllowed: true });

  it("sin saber cómo se descongeló → revisar (ni prohibido ni aprobado)", () => {
    expect(assessRefreeze(hechos(), null, [reglaRefreeze]).verdict).toBe("SAFETY_REVIEW_REQUIRED");
    expect(assessRefreeze(hechos(), false, [reglaRefreeze]).verdict).toBe("SAFETY_REVIEW_REQUIRED");
  });

  it("descongelado en refrigerador + regla que lo permite → ALLOWED con fuente", () => {
    expect(assessRefreeze(hechos(), true, [reglaRefreeze]).verdict).toBe("ALLOWED");
  });

  it("descongelado en refrigerador SIN regla → revisar", () => {
    expect(assessRefreeze(hechos(), true, []).verdict).toBe("SAFETY_REVIEW_REQUIRED");
  });
});

describe("§29 — descongelado programado solo con regla", () => {
  it("regla THAW de 24 h → traslado un día antes, con la nota y la fuente", () => {
    const thaw = regla({ id: "r-thaw", ruleKind: "THAW", temperatureState: "FROZEN", thawFridgeHours: 24 });
    const p = planThaw(hechos({ temperatureState: "FROZEN" }), "2026-08-27", [thaw]);
    expect(p).toMatchObject({ kind: "SCHEDULED", moveDate: "2026-08-26" });
  });

  it("sin regla → 'revisar descongelado', jamás una hora inventada", () => {
    const p = planThaw(hechos({ temperatureState: "FROZEN" }), "2026-08-27", []);
    expect(p.kind).toBe("REVIEW");
  });
});
