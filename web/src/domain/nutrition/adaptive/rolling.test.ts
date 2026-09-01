import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  NUTRIENT_KEYS,
  type AggregatedNutrition,
  type NutrientKey,
  type NutritionCompleteness,
  type NutritionValues,
} from "@/domain/catalog/types";
import { GOAL_TYPES, type GoalType, type TargetSet } from "@/domain/nutrition/types";

import {
  ROLLING_BALANCE_VERSION,
  ROLLING_WINDOW_DAYS,
  goalTypeToNutrientKey,
  nutrientKeyToGoalType,
  rollingBalance,
  type DayIntake,
  type RollingBalanceInput,
} from "./rolling";

/**
 * Estos tests existen para probar el camino donde el sistema NO SABE. Un motor
 * de este tipo probado solo con días perfectos no está probado: la mitad de su
 * trabajo es negarse a responder.
 */

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

/**
 * Vector nutricional con la MISMA forma que produce `sumAbsoluteNutrients`:
 * un nutriente que no viene queda en null + UNKNOWN, jamás en 0.
 */
function vector(
  valores: Partial<Record<NutrientKey, number>>,
  parciales: readonly NutrientKey[] = [],
): AggregatedNutrition {
  const values: NutritionValues = {};
  const completeness = {} as NutritionCompleteness;
  for (const key of NUTRIENT_KEYS) {
    const v = valores[key];
    if (v === undefined) {
      values[key] = null;
      completeness[key] = "UNKNOWN";
    } else {
      values[key] = v;
      completeness[key] = parciales.includes(key) ? "PARTIAL" : "COMPLETE";
    }
  }
  return { values, completeness, contributors: 1 };
}

function dia(date: string, over: Partial<DayIntake> = {}): DayIntake {
  return {
    date,
    planned: null,
    served: null,
    actual: null,
    mealsExpected: 3,
    mealsServed: 0,
    mealsLogged: 0,
    unassignedLogs: 0,
    unknownQuantityItems: 0,
    trackingMode: "FULL",
    skipTracking: false,
    isClosed: true,
    ...over,
  };
}

function metas(valores: Partial<Record<GoalType, number>>): TargetSet {
  const set: TargetSet = {};
  for (const goalType of GOAL_TYPES) {
    const preferred = valores[goalType];
    if (preferred !== undefined) set[goalType] = { minimum: null, preferred, maximum: null };
  }
  return set;
}

function metasPorDia(fechas: readonly string[], valores: Partial<Record<GoalType, number>>) {
  const out: Record<string, TargetSet> = {};
  for (const fecha of fechas) out[fecha] = metas(valores);
  return out;
}

const D3 = ["2026-08-05", "2026-08-06", "2026-08-07"] as const;

// ---------------------------------------------------------------------------
// Pureza y determinismo
// ---------------------------------------------------------------------------

describe("el motor es puro, sin reloj y determinista", () => {
  const FUENTE = readFileSync(path.join(__dirname, "rolling.ts"), "utf8");

  it("no lee el reloj: la fecha entra por input", () => {
    expect(/new Date\(\)|Date\.now\(\)/.test(FUENTE)).toBe(false);
  });

  it("no rellena desconocidos: sin `?? 0`, sin `|| 0`, sin `|| []`", () => {
    const ofensas = [...FUENTE.matchAll(/\?\?\s*(0(?![.\d])|\[\])|\|\|\s*(0(?![.\d])|\[\])/g)].map(
      (m) => m[0],
    );
    expect(ofensas).toEqual([]);
  });

  it("no habla con nadie: sin red, sin base, sin IA", () => {
    expect(/fetch\(|supabase|openai|anthropic|createClient/i.test(FUENTE)).toBe(false);
  });

  it("mismo input ⇒ mismo JSON byte a byte", () => {
    const input: RollingBalanceInput = {
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f) => dia(f, { mealsLogged: 3, actual: vector({ energy_kcal: 1900 }) })),
      targetsByDate: metasPorDia(D3, { ENERGY_KCAL: 2000 }),
    };
    const a = JSON.stringify(rollingBalance(input));
    const b = JSON.stringify(rollingBalance(input));
    expect(a).toBe(b);
  });

  it("las claves de `balances` salen siempre en el orden de NUTRIENT_KEYS", () => {
    const r = rollingBalance({
      window: "W24H",
      endDate: "2026-08-07",
      days: [dia("2026-08-07", { mealsLogged: 3, actual: vector({ energy_kcal: 100 }) })],
      targetsByDate: metasPorDia(["2026-08-07"], { ENERGY_KCAL: 100 }),
    });
    expect(Object.keys(r.balances)).toEqual([...NUTRIENT_KEYS]);
    expect(r.engineVersion).toBe(ROLLING_BALANCE_VERSION);
  });
});

// ---------------------------------------------------------------------------
// La ventana: fechas DATE-only, sin husos
// ---------------------------------------------------------------------------

describe("la ventana se calcula con fechas DATE-only", () => {
  it("W24H empieza y termina el mismo día", () => {
    const r = rollingBalance({
      window: "W24H",
      endDate: "2026-08-07",
      days: [],
      targetsByDate: {},
    });
    expect(r.startDate).toBe("2026-08-07");
    expect(r.endDate).toBe("2026-08-07");
    expect(r.coverage.daysExpected).toBe(ROLLING_WINDOW_DAYS.W24H);
  });

  it("D7 cruza el borde de mes hacia atrás", () => {
    const r = rollingBalance({ window: "D7", endDate: "2026-03-02", days: [], targetsByDate: {} });
    expect(r.startDate).toBe("2026-02-24");
  });

  it("D3 cruza el 29 de febrero de un año bisiesto", () => {
    const r = rollingBalance({ window: "D3", endDate: "2024-03-01", days: [], targetsByDate: {} });
    expect(r.startDate).toBe("2024-02-28");
  });

  it("el cambio de hora en Chile no mueve la ventana", () => {
    // 2026-09-06: en Chile el reloj salta a medianoche. Un motor con husos
    // horarios devolvería un día corrido; este trabaja en día civil.
    const r = rollingBalance({ window: "D3", endDate: "2026-09-07", days: [], targetsByDate: {} });
    expect(r.startDate).toBe("2026-09-05");
  });

  it("rechaza una fecha con forma inválida", () => {
    expect(() =>
      rollingBalance({ window: "D3", endDate: "07-08-2026", days: [], targetsByDate: {} }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it("rechaza una fecha que no existe en el calendario", () => {
    expect(() =>
      rollingBalance({ window: "D3", endDate: "2026-02-30", days: [], targetsByDate: {} }),
    ).toThrow(/calendario/);
  });

  it("rechaza un día fuera de la ventana en vez de ignorarlo en silencio", () => {
    expect(() =>
      rollingBalance({
        window: "D3",
        endDate: "2026-08-07",
        days: [dia("2026-08-01")],
        targetsByDate: {},
      }),
    ).toThrow(/no pertenece a la ventana/);
  });

  it("rechaza días desordenados o repetidos", () => {
    expect(() =>
      rollingBalance({
        window: "D3",
        endDate: "2026-08-07",
        days: [dia("2026-08-06"), dia("2026-08-05")],
        targetsByDate: {},
      }),
    ).toThrow(/ordenado/);
    expect(() =>
      rollingBalance({
        window: "D3",
        endDate: "2026-08-07",
        days: [dia("2026-08-06"), dia("2026-08-06")],
        targetsByDate: {},
      }),
    ).toThrow(/ordenado/);
  });
});

// ---------------------------------------------------------------------------
// Cobertura: las cuatro ramas + el caso que rompe a todo el mundo
// ---------------------------------------------------------------------------

describe("cobertura", () => {
  function conRatio(logged: readonly number[]) {
    return rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f, i) =>
        dia(f, {
          mealsExpected: 3,
          mealsLogged: logged[i]!,
          actual: logged[i]! > 0 ? vector({ energy_kcal: 600 * logged[i]! }) : null,
        }),
      ),
      targetsByDate: metasPorDia(D3, { ENERGY_KCAL: 2000 }),
    });
  }

  it("FULL: nada falta y todas las comidas registradas", () => {
    const r = conRatio([3, 3, 3]);
    expect(r.coverage.kind).toBe("FULL");
    expect(r.coverage.mealRatio).toBe(1);
    expect(r.coverage.missing).toEqual([]);
    expect(r.confidence.reasons).toContain("COVERAGE_FULL");
  });

  it("PARTIAL: mealRatio >= 0,6", () => {
    const r = conRatio([3, 3, 0]);
    expect(r.coverage.kind).toBe("PARTIAL");
    expect(r.coverage.mealRatio).toBeCloseTo(6 / 9, 10);
    expect(r.coverage.missing).toEqual([
      { date: "2026-08-07", mealsMissing: 3, reason: "NO_LOG" },
    ]);
  });

  it("SPARSE: algo hay, pero muy poco", () => {
    const r = conRatio([2, 0, 0]);
    expect(r.coverage.kind).toBe("SPARSE");
    expect(r.confidence.level).toBe("LOW");
    expect(r.coverage.missing.map((m) => m.reason)).toEqual(["PARTIAL_LOG", "NO_LOG", "NO_LOG"]);
  });

  it("NONE: no se registró nada", () => {
    const r = conRatio([0, 0, 0]);
    expect(r.coverage.kind).toBe("NONE");
    expect(r.coverage.mealRatio).toBe(0);
    expect(r.confidence.level).toBe("NONE");
  });

  it("mealRatio es NULL —ni 1 ni 0— cuando el patrón no espera comidas", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f) => dia(f, { mealsExpected: 0, mealsLogged: 0 })),
      targetsByDate: metasPorDia(D3, { ENERGY_KCAL: 2000 }),
    });
    expect(r.coverage.mealRatio).toBeNull();
    expect(r.coverage.mealsExpected).toBe(0);
    expect(r.coverage.kind).toBe("NONE");
    expect(r.confidence.level).toBe("NONE");
  });

  it("registrar de MÁS no degrada a PARTIAL, pero un día corto sí", () => {
    const completo = conRatio([4, 3, 3]);
    expect(completo.coverage.kind).toBe("FULL");
    const desparejo = conRatio([5, 3, 1]);
    expect(desparejo.coverage.mealRatio).toBeGreaterThan(0.9);
    expect(desparejo.coverage.kind).toBe("PARTIAL");
  });

  it("los snacks sueltos se informan aparte y NO tocan el mealRatio", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f) =>
        dia(f, { mealsLogged: 3, unassignedLogs: 2, actual: vector({ energy_kcal: 1800 }) }),
      ),
      targetsByDate: metasPorDia(D3, { ENERGY_KCAL: 2000 }),
    });
    expect(r.coverage.unassignedLogs).toBe(6);
    expect(r.coverage.mealRatio).toBe(1);
    expect(r.coverage.kind).toBe("FULL");
  });
});

// ---------------------------------------------------------------------------
// Persona nueva vs día sin registro: dos campos, dos razones
// ---------------------------------------------------------------------------

describe("faltar de la historia no es lo mismo que no registrar", () => {
  it("los días que no existen se cuentan aparte y con su propia razón", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: [
        dia("2026-08-06", { mealsLogged: 0 }),
        dia("2026-08-07", { mealsLogged: 3, actual: vector({ energy_kcal: 1800 }) }),
      ],
      targetsByDate: metasPorDia(D3, { ENERGY_KCAL: 2000 }),
    });

    expect(r.coverage.daysMissingFromHistory).toBe(1);
    expect(r.coverage.missing).toEqual([
      { date: "2026-08-05", mealsMissing: null, reason: "NOT_IN_HISTORY" },
      { date: "2026-08-06", mealsMissing: 3, reason: "NO_LOG" },
    ]);
    expect(r.confidence.reasons).toContain("SHORT_HISTORY");
  });

  it("de un día que no existe NO se inventa cuántas comidas faltaron", () => {
    const r = rollingBalance({ window: "D3", endDate: "2026-08-07", days: [], targetsByDate: {} });
    expect(r.coverage.missing.every((m) => m.mealsMissing === null)).toBe(true);
    expect(r.coverage.mealsExpected).toBe(0);
    expect(r.coverage.mealRatio).toBeNull();
  });

  it("faltar de la historia impide la cobertura FULL aunque lo presente esté perfecto", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: [dia("2026-08-07", { mealsLogged: 3, actual: vector({ energy_kcal: 2000 }) })],
      targetsByDate: metasPorDia(D3, { ENERGY_KCAL: 2000 }),
    });
    expect(r.coverage.mealRatio).toBe(1);
    expect(r.coverage.kind).toBe("PARTIAL");
    expect(r.confidence.level).not.toBe("HIGH");
  });
});

// ---------------------------------------------------------------------------
// UNKNOWN != ZERO
// ---------------------------------------------------------------------------

describe("un nutriente que no se sabe se dice, no se calcula", () => {
  it("nutriente UNKNOWN ⇒ actual null, delta null, confianza NONE", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f) => dia(f, { mealsLogged: 3, actual: vector({ energy_kcal: 2000 }) })),
      targetsByDate: metasPorDia(D3, { ENERGY_KCAL: 2000, PROTEIN_G: 90 }),
    });

    const proteina = r.balances.protein_g;
    expect(proteina.actual).toBeNull();
    expect(proteina.delta).toBeNull();
    expect(proteina.deltaRatio).toBeNull();
    expect(proteina.daysCounted).toBe(0);
    expect(proteina.completeness).toBe("UNKNOWN");
    expect(proteina.confidence.level).toBe("NONE");
    expect(proteina.confidence.reasons).toContain("NUTRIENT_UNKNOWN");
  });

  it("un día conocido y otro no ⇒ PARTIAL, cota inferior, y dice de cuántos días sale", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: [
        dia("2026-08-05", { mealsLogged: 3, actual: vector({ energy_kcal: 1800, protein_g: 80 }) }),
        dia("2026-08-06", { mealsLogged: 3, actual: vector({ energy_kcal: 1900 }) }),
        dia("2026-08-07", { mealsLogged: 3, actual: vector({ energy_kcal: 2000, protein_g: 70 }) }),
      ],
      targetsByDate: metasPorDia(D3, { ENERGY_KCAL: 2000, PROTEIN_G: 90 }),
    });

    const proteina = r.balances.protein_g;
    expect(proteina.actual).toBe(150);
    expect(proteina.daysCounted).toBe(2);
    expect(proteina.daysWithTarget).toBe(3);
    expect(proteina.daysComparable).toBe(2);
    expect(proteina.completeness).toBe("PARTIAL");
    expect(proteina.isLowerBound).toBe(true);
    // El objetivo se suma SOLO sobre los días que aportaron: 2 x 90, no 3 x 90.
    expect(proteina.target).toBe(180);
    expect(proteina.delta).toBe(-30);
    expect(proteina.confidence.reasons).toContain("NUTRIENT_PARTIAL");
    expect(proteina.confidence.reasons).toContain("NUTRIENT_LOWER_BOUND");
  });

  it("una suma parcial DENTRO del día también deja el total en cota inferior", () => {
    const r = rollingBalance({
      window: "W24H",
      endDate: "2026-08-07",
      days: [
        dia("2026-08-07", {
          mealsLogged: 3,
          actual: vector({ energy_kcal: 1500 }, ["energy_kcal"]),
        }),
      ],
      targetsByDate: metasPorDia(["2026-08-07"], { ENERGY_KCAL: 2000 }),
    });
    const energia = r.balances.energy_kcal;
    expect(energia.daysCounted).toBe(1);
    expect(energia.completeness).toBe("PARTIAL");
    expect(energia.isLowerBound).toBe(true);
    expect(energia.confidence.level).toBe("MEDIUM");
  });

  it("cero CONOCIDO no es desconocido: 'no comí' es un dato", () => {
    const r = rollingBalance({
      window: "W24H",
      endDate: "2026-08-07",
      days: [dia("2026-08-07", { mealsLogged: 3, actual: vector({ energy_kcal: 0 }) })],
      targetsByDate: metasPorDia(["2026-08-07"], { ENERGY_KCAL: 2000 }),
    });
    const energia = r.balances.energy_kcal;
    expect(energia.actual).toBe(0);
    expect(energia.completeness).toBe("COMPLETE");
    expect(energia.delta).toBe(-2000);
    expect(energia.deltaRatio).toBe(-1);
  });

  it("un vector que se contradice es un ERROR, no un vacío", () => {
    const roto: AggregatedNutrition = {
      values: { energy_kcal: null },
      completeness: { energy_kcal: "COMPLETE" } as NutritionCompleteness,
      contributors: 1,
    };
    expect(() =>
      rollingBalance({
        window: "W24H",
        endDate: "2026-08-07",
        days: [dia("2026-08-07", { mealsLogged: 3, actual: roto })],
        targetsByDate: metasPorDia(["2026-08-07"], { ENERGY_KCAL: 2000 }),
      }),
    ).toThrow(/se contradicen|completitud/);
  });
});

// ---------------------------------------------------------------------------
// Los denominadores: `actual` y `target` salen del MISMO conjunto de días
// ---------------------------------------------------------------------------

describe("actual y target nunca comparan universos distintos", () => {
  it("7 días con 3 registrados da el MISMO delta que 3 días con esos 3 registros", () => {
    const registrados = D3.map((f) =>
      dia(f, { mealsLogged: 3, actual: vector({ energy_kcal: 1700 }) }),
    );
    const vacios = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"].map((f) =>
      dia(f, { mealsLogged: 0 }),
    );
    const todas = [...vacios, ...registrados].map((d) => d.date);

    const semana = rollingBalance({
      window: "D7",
      endDate: "2026-08-07",
      days: [...vacios, ...registrados],
      targetsByDate: metasPorDia(todas, { ENERGY_KCAL: 2000 }),
    });
    const tres = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: registrados,
      targetsByDate: metasPorDia([...D3], { ENERGY_KCAL: 2000 }),
    });

    expect(semana.balances.energy_kcal.delta).toBe(tres.balances.energy_kcal.delta);
    expect(semana.balances.energy_kcal.target).toBe(6000);
    expect(semana.balances.energy_kcal.daysWithTarget).toBe(7);
    expect(semana.balances.energy_kcal.daysCounted).toBe(3);
    // Y la cobertura sí distingue las dos situaciones.
    expect(semana.coverage.kind).toBe("SPARSE");
    expect(tres.coverage.kind).toBe("FULL");
  });

  it("un día con comida y SIN objetivo no produce delta: se declara el desajuste", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f) => dia(f, { mealsLogged: 3, actual: vector({ energy_kcal: 1800 }) })),
      targetsByDate: {
        "2026-08-05": metas({ ENERGY_KCAL: 2000 }),
        "2026-08-06": metas({ ENERGY_KCAL: 2000 }),
        "2026-08-07": metas({}),
      },
    });
    const energia = r.balances.energy_kcal;
    expect(energia.actual).toBe(5400);
    expect(energia.daysCounted).toBe(3);
    expect(energia.daysComparable).toBe(2);
    expect(energia.delta).toBeNull();
    expect(energia.deltaRatio).toBeNull();
    expect(energia.confidence.reasons).toContain("TARGET_DAYS_MISMATCH");
    expect(energia.confidence.level).toBe("MEDIUM");
  });

  it("los días que nadie pidió medir no entran en NINGÚN denominador", () => {
    const semana = [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ];
    const r = rollingBalance({
      window: "D7",
      endDate: "2026-08-07",
      days: semana.map((f, i) =>
        i < 4
          ? dia(f, { skipTracking: true, mealsLogged: 0 })
          : dia(f, { mealsLogged: 3, actual: vector({ energy_kcal: 1900 }) }),
      ),
      targetsByDate: metasPorDia(semana, { ENERGY_KCAL: 2000 }),
    });

    const energia = r.balances.energy_kcal;
    expect(r.coverage.daysUntracked).toBe(4);
    expect(energia.daysWithTarget).toBe(3);
    expect(energia.target).toBe(6000);
    expect(energia.delta).toBe(-300);
    expect(r.confidence.reasons).toContain("DAY_UNTRACKED");
    // Cobertura completa de lo medible, pero la ventana no está entera: la
    // confianza máxima exige los 7 días, no 3 de 7.
    expect(r.coverage.kind).toBe("FULL");
    expect(r.confidence.level).toBe("MEDIUM");
  });

  it("tracking OFF se distingue de SKIP_TRACKING", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: [
        dia("2026-08-05", { trackingMode: "OFF" }),
        dia("2026-08-06", { skipTracking: true }),
        dia("2026-08-07", { mealsLogged: 3, actual: vector({ energy_kcal: 2000 }) }),
      ],
      targetsByDate: metasPorDia([...D3], { ENERGY_KCAL: 2000 }),
    });
    expect(r.coverage.daysUntracked).toBe(2);
    expect(r.confidence.reasons).toContain("TRACKING_OFF");
    expect(r.confidence.reasons).toContain("DAY_UNTRACKED");
    expect(r.balances.energy_kcal.daysCounted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// El día en curso
// ---------------------------------------------------------------------------

describe("un día a medio vivir no es un día con déficit", () => {
  it("el día en curso no entra en el denominador y se declara aparte", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: [
        dia("2026-08-05", { mealsLogged: 3, actual: vector({ energy_kcal: 2000 }) }),
        dia("2026-08-06", { mealsLogged: 3, actual: vector({ energy_kcal: 2000 }) }),
        // Son las 14:00: desayuno y almuerzo anotados, la cena todavía no ocurre.
        dia("2026-08-07", {
          isClosed: false,
          mealsLogged: 2,
          actual: vector({ energy_kcal: 1200 }),
        }),
      ],
      targetsByDate: metasPorDia([...D3], { ENERGY_KCAL: 2000 }),
    });

    expect(r.coverage.daysInProgress).toBe(1);
    expect(r.coverage.mealsExpected).toBe(6);
    expect(r.coverage.mealRatio).toBe(1);
    expect(r.confidence.reasons).toContain("DAY_IN_PROGRESS");
    // Las 1200 kcal a medio día NO se restan contra 2000: ese día no se mide.
    expect(r.balances.energy_kcal.actual).toBe(4000);
    expect(r.balances.energy_kcal.delta).toBe(0);
    expect(r.confidence.level).toBe("MEDIUM");
  });

  it("W24H sobre el día de hoy responde 'no sé', no un déficit", () => {
    const r = rollingBalance({
      window: "W24H",
      endDate: "2026-08-07",
      days: [
        dia("2026-08-07", { isClosed: false, mealsLogged: 2, actual: vector({ energy_kcal: 900 }) }),
      ],
      targetsByDate: metasPorDia(["2026-08-07"], { ENERGY_KCAL: 2000 }),
    });

    expect(r.coverage.kind).toBe("NONE");
    expect(r.coverage.mealRatio).toBeNull();
    expect(r.confidence.level).toBe("NONE");
    expect(r.balances.energy_kcal.actual).toBeNull();
    expect(r.balances.energy_kcal.target).toBeNull();
    expect(r.balances.energy_kcal.delta).toBeNull();
    expect(r.balances.energy_kcal.completeness).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// Confianza
// ---------------------------------------------------------------------------

describe("confianza", () => {
  it("HIGH exige ventana entera, todo registrado, completo y sin cantidades desconocidas", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f) =>
        dia(f, { mealsLogged: 3, actual: vector({ energy_kcal: 2000, protein_g: 90 }) }),
      ),
      targetsByDate: metasPorDia([...D3], { ENERGY_KCAL: 2000, PROTEIN_G: 90 }),
    });
    expect(r.confidence.level).toBe("HIGH");
    expect(r.balances.energy_kcal.delta).toBe(0);
  });

  it("un solo ítem con cantidad desconocida ya baja el techo a MEDIUM", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f, i) =>
        dia(f, {
          mealsLogged: 3,
          unknownQuantityItems: i === 1 ? 1 : 0,
          actual: vector({ energy_kcal: 2000 }),
        }),
      ),
      targetsByDate: metasPorDia([...D3], { ENERGY_KCAL: 2000 }),
    });
    expect(r.coverage.unknownQuantityItems).toBe(1);
    expect(r.confidence.reasons).toContain("UNKNOWN_QUANTITIES_PRESENT");
    expect(r.confidence.level).toBe("MEDIUM");
  });

  it("la confianza combinada es el PEOR de los nutrientes que participan", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f) =>
        dia(f, {
          mealsLogged: 3,
          // Todo conocido salvo la fibra, que además tiene objetivo declarado.
          actual: vector({
            energy_kcal: 2000,
            protein_g: 90,
            carbohydrates_g: 220,
            fat_g: 70,
          }),
        }),
      ),
      targetsByDate: metasPorDia([...D3], {
        ENERGY_KCAL: 2000,
        PROTEIN_G: 90,
        CARBOHYDRATE_G: 220,
        FAT_G: 70,
        FIBER_G: 30,
      }),
    });

    expect(r.balances.energy_kcal.confidence.level).toBe("HIGH");
    expect(r.balances.fiber_g.confidence.level).toBe("NONE");
    expect(r.confidence.level).toBe("NONE");
    expect(r.confidence.reasons).toContain("NUTRIENT_UNKNOWN");
  });

  it("un nutriente sin objetivo posible no arrastra la confianza", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f) => dia(f, { mealsLogged: 3, actual: vector({ energy_kcal: 2000 }) })),
      targetsByDate: metasPorDia([...D3], { ENERGY_KCAL: 2000 }),
    });
    // El sodio no se conoce y NADIE puede fijarse un objetivo de sodio.
    expect(r.balances.sodium_mg.completeness).toBe("UNKNOWN");
    expect(r.balances.sodium_mg.daysWithTarget).toBe(0);
    expect(r.confidence.level).toBe("HIGH");
  });

  it("sin ningún objetivo declarado no hay nada que afirmar", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f) => dia(f, { mealsLogged: 3, actual: vector({ energy_kcal: 2000 }) })),
      targetsByDate: {},
    });
    expect(r.confidence.level).toBe("NONE");
    expect(r.balances.energy_kcal.actual).toBe(6000);
    expect(r.balances.energy_kcal.target).toBeNull();
    expect(r.balances.energy_kcal.delta).toBeNull();
  });

  it("con tracking BASIC la energía no puede llegar a HIGH", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f) =>
        dia(f, {
          trackingMode: "BASIC",
          mealsLogged: 3,
          actual: vector({ energy_kcal: 2000, protein_g: 90 }),
        }),
      ),
      targetsByDate: metasPorDia([...D3], { ENERGY_KCAL: 2000, PROTEIN_G: 90 }),
    });
    expect(r.balances.energy_kcal.confidence.level).toBe("MEDIUM");
    expect(r.balances.energy_kcal.confidence.reasons).toContain("TRACKING_BASIC_NO_ENERGY");
    expect(r.balances.protein_g.confidence.level).toBe("HIGH");
    expect(r.confidence.level).toBe("MEDIUM");
  });

  it("las razones combinadas no se repiten aunque las cause más de un nutriente", () => {
    const r = rollingBalance({
      window: "D3",
      endDate: "2026-08-07",
      days: D3.map((f) => dia(f, { mealsLogged: 3, actual: vector({ energy_kcal: 2000 }) })),
      targetsByDate: metasPorDia([...D3], { ENERGY_KCAL: 2000, PROTEIN_G: 90, FIBER_G: 30 }),
    });
    const unicas = new Set(r.confidence.reasons);
    expect(unicas.size).toBe(r.confidence.reasons.length);
    expect(r.confidence.reasons).toContain("NUTRIENT_UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// El mapeo objetivo ↔ nutriente
// ---------------------------------------------------------------------------

describe("goalTypeToNutrientKey", () => {
  it("traduce los cinco objetivos, con el plural de los carbohidratos incluido", () => {
    expect(goalTypeToNutrientKey("ENERGY_KCAL")).toBe("energy_kcal");
    expect(goalTypeToNutrientKey("PROTEIN_G")).toBe("protein_g");
    expect(goalTypeToNutrientKey("CARBOHYDRATE_G")).toBe("carbohydrates_g");
    expect(goalTypeToNutrientKey("FAT_G")).toBe("fat_g");
    expect(goalTypeToNutrientKey("FIBER_G")).toBe("fiber_g");
  });

  it("todo GoalType apunta a un NutrientKey real y ninguno se repite", () => {
    const claves = GOAL_TYPES.map(goalTypeToNutrientKey);
    for (const clave of claves) expect(NUTRIENT_KEYS).toContain(clave);
    expect(new Set(claves).size).toBe(GOAL_TYPES.length);
  });

  it("la vuelta dice NULL para los nutrientes que ningún objetivo puede expresar", () => {
    expect(nutrientKeyToGoalType("carbohydrates_g")).toBe("CARBOHYDRATE_G");
    expect(nutrientKeyToGoalType("sodium_mg")).toBeNull();
    expect(nutrientKeyToGoalType("phosphorus_mg")).toBeNull();
    for (const goalType of GOAL_TYPES) {
      expect(nutrientKeyToGoalType(goalTypeToNutrientKey(goalType))).toBe(goalType);
    }
  });
});
