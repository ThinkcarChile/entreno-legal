import { describe, expect, it } from "vitest";
import {
  NUTRIENT_KEYS,
  type AggregatedNutrition,
  type NutrientKey,
  type NutritionCompleteness,
  type NutritionValues,
} from "@/domain/catalog/types";
import { GOAL_TYPES, type GoalType, type TargetSet } from "@/domain/nutrition/types";
import type { EventEffect } from "@/domain/nutrition/events";
import { rollingBalance, type DayIntake, type RollingBalance } from "./rolling";
import { reviewAdaptiveNutrition } from "./engine";
import type { AdaptiveInput } from "./types";

/**
 * "NO PUDE COMPARAR" JAMÁS SE DICE COMO "QUEDASTE BIEN".
 *
 * El caso que destapó esto es de lo más normal del mundo: alguien declara su
 * objetivo de energía ANTEAYER. Hoy y ayer tienen meta; los días más viejos de
 * la ventana de 7 no. `rollingBalance` hace lo correcto — los días con comida y
 * los días con objetivo no son el mismo universo, restar fabricaría un desvío
 * que nadie vivió, así que deja `delta` y `deltaRatio` en null.
 *
 * Pero ese null llegaba a engine.ts con `completeness: "COMPLETE"` (la comida
 * SÍ se conocía entera), y el motor tenía un solo guard para el null, que
 * exigía UNKNOWN. El null de "no pude comparar" pasaba de largo, caía en el
 * mismo `continue` que el de "no hay señal", y el veredicto salía:
 *
 *     NO_CHANGE · «Lo de este día quedó dentro del rango que declaraste»
 *     missingData: []
 *
 * La persona había comido un 50 % SOBRE su objetivo seis días seguidos. El
 * motor no es que se callara: AFIRMABA algo positivo sobre una comparación que
 * nunca hizo. types.ts lo prohíbe con todas sus letras: «INSUFFICIENT_DATA no
 * es NO_CHANGE… UNKNOWN nunca significa NORMAL».
 *
 * El arreglo separa los dos nulls: la ventana incomparable se declara
 * (NO_COMPARABLE_TARGET_DAYS), empuja el veredicto a INSUFFICIENT_DATA con su
 * missingData, y «quedaste dentro del rango» solo se dice cuando de verdad hubo
 * con qué compararlo.
 */

const D7 = [
  "2026-08-01",
  "2026-08-02",
  "2026-08-03",
  "2026-08-04",
  "2026-08-05",
  "2026-08-06",
  "2026-08-07",
] as const;
const HOY = "2026-08-07";
/** El objetivo se declaró anteayer: solo los dos últimos días tienen meta. */
const CON_META = new Set<string>(["2026-08-06", "2026-08-07"]);

function vector(valores: Partial<Record<NutrientKey, number>>): AggregatedNutrition {
  const values: NutritionValues = {};
  const completeness = {} as NutritionCompleteness;
  for (const key of NUTRIENT_KEYS) {
    const v = valores[key];
    if (v === undefined) {
      values[key] = null;
      completeness[key] = "UNKNOWN";
    } else {
      values[key] = v;
      completeness[key] = "COMPLETE";
    }
  }
  return { values, completeness, contributors: 1 };
}

function dia(date: string, kcal: number): DayIntake {
  return {
    date,
    planned: null,
    served: null,
    actual: vector({ energy_kcal: kcal }),
    mealsExpected: 3,
    mealsServed: 3,
    mealsLogged: 3,
    unassignedLogs: 0,
    unknownQuantityItems: 0,
    trackingMode: "FULL",
    skipTracking: false,
    isClosed: true,
  };
}

function meta(preferido: number): TargetSet {
  const set: TargetSet = {};
  for (const g of GOAL_TYPES) {
    if (g === "ENERGY_KCAL") set[g] = { minimum: 1600, preferred: preferido, maximum: 2200 };
  }
  return set;
}

const OBJETIVOS = meta(2000);
/** Solo los días donde el objetivo ya existía. Los viejos no tienen entrada. */
const POR_DIA = Object.fromEntries([...CON_META].map((f) => [f, OBJETIVOS]));

function ventana(w: "W24H" | "D3" | "D7", fechas: readonly string[], kcalPorDia: (f: string) => number): RollingBalance {
  return rollingBalance({
    window: w,
    endDate: HOY,
    days: fechas.map((f) => dia(f, kcalPorDia(f))),
    targetsByDate: POR_DIA,
  });
}

const SIN_EVENTO: EventEffect = { kind: "NONE", event: null, text: "" };

function entrada(kcalPorDia: (f: string) => number): AdaptiveInput {
  return {
    date: HOY,
    memberId: "m-1",
    trackingMode: "FULL",
    dailyTargets: OBJETIVOS,
    resolvedTargets: OBJETIVOS,
    eventEffect: SIN_EVENTO,
    balances: [
      ventana("W24H", [HOY], kcalPorDia),
      ventana("D3", D7.slice(4), kcalPorDia),
      ventana("D7", D7, kcalPorDia),
    ],
    clinicalContextResolved: true,
    clinicalCeilings: [],
    clinicalFloors: [],
    clinicalUnusableLimits: [],
    clinicalStatus: "COMPATIBLE",
    pendingClinicalReviews: 0,
    activeClinicalRestrictions: 0,
  };
}

describe("una ventana incomparable no se lee como «quedaste bien»", () => {
  // El caso exacto del ataque: +50 % seis días seguidos, y hoy justo en la meta.
  const kcal = (f: string) => (f === HOY ? 2000 : 3000);

  it("rollingBalance declara la incomparabilidad, no la esconde", () => {
    const d7 = ventana("D7", D7, kcal).balances.energy_kcal;
    expect(d7.daysCounted).toBe(7);
    expect(d7.daysComparable).toBe(2);
    expect(d7.delta, "restó sumas de universos distintos").toBeNull();
    expect(d7.confidence.reasons).toContain("TARGET_DAYS_MISMATCH");
  });

  it("el veredicto es INSUFFICIENT_DATA con la falta nombrada, no NO_CHANGE", () => {
    const review = reviewAdaptiveNutrition(entrada(kcal));

    expect(review.verdict, "afirmó normalidad sobre una comparación que no se hizo").toBe(
      "INSUFFICIENT_DATA",
    );
    expect(review.reasons.map((r) => r.code)).toContain("NO_COMPARABLE_TARGET_DAYS");
    expect(review.missingData.length, "no dijo qué faltó").toBeGreaterThan(0);

    // Y lo que NO puede aparecer: la afirmación positiva sobre el rango.
    expect(
      review.reasons.map((r) => r.code),
      "dijo «dentro del rango» sin haber comparado las ventanas largas",
    ).not.toContain("WITHIN_NOISE_BAND");
  });

  it("el gemelo: con objetivo declarado TODOS los días, el motor sí opina", () => {
    // Si el arreglo hubiera vuelto mudo al motor, esto lo delata: mismo exceso
    // sostenido, pero ahora todos los días tienen meta, así que D3 y D7 son
    // comparables y el veredicto tiene que reportar el superávit.
    const todos = Object.fromEntries(D7.map((f) => [f, OBJETIVOS]));
    const conMeta = (w: "W24H" | "D3" | "D7", fechas: readonly string[]) =>
      rollingBalance({
        window: w,
        endDate: HOY,
        days: fechas.map((f) => dia(f, 3000)),
        targetsByDate: todos,
      });
    const review = reviewAdaptiveNutrition({
      ...entrada(() => 3000),
      balances: [conMeta("W24H", [HOY]), conMeta("D3", D7.slice(4)), conMeta("D7", D7)],
    });

    expect(review.verdict).not.toBe("INSUFFICIENT_DATA");
    expect(review.reasons.map((r) => r.code)).toContain("SUSTAINED_SURPLUS");
  });

  it("y sin ningún objetivo en ninguna parte, la razón es la de siempre", () => {
    // Tercer camino, para que el arreglo no se coma al vecino: sin objetivo
    // DECLARADO no hay incomparabilidad que reportar — hay ausencia de meta, y
    // esa ya tenía su código propio.
    const review = reviewAdaptiveNutrition({
      ...entrada(kcal),
      dailyTargets: {},
      resolvedTargets: {},
      balances: [
        rollingBalance({ window: "W24H", endDate: HOY, days: [dia(HOY, 2000)], targetsByDate: {} }),
        rollingBalance({ window: "D3", endDate: HOY, days: D7.slice(4).map((f) => dia(f, kcal(f))), targetsByDate: {} }),
        rollingBalance({ window: "D7", endDate: HOY, days: D7.map((f) => dia(f, kcal(f))), targetsByDate: {} }),
      ],
    });
    expect(review.reasons.map((r) => r.code)).toContain("NO_TARGET_DECLARED");
    expect(review.reasons.map((r) => r.code)).not.toContain("NO_COMPARABLE_TARGET_DAYS");
  });
});
