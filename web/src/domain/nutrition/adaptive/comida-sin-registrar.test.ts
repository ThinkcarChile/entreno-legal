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
 * NO ANOTAR EL ALMUERZO NO ES HABER AYUNADO.
 *
 * Este archivo nace de un ataque que encontró el defecto más caro de los dos
 * motores. La situación es de todos los días: alguien registra el desayuno y la
 * cena, se le pasa el almuerzo, y hace eso tres días seguidos.
 *
 * Lo que el motor de balance devolvía:
 *
 *     completeness COMPLETE · isLowerBound false · delta −2.400 kcal (−40 %)
 *
 * O sea: afirmaba, con cara de medición completa, un déficit del cuarenta por
 * ciento que esa persona nunca vivió. Comió — no anotó.
 *
 * Lo peor no era el número: era a dónde iba. El motor adaptativo SÍ tenía
 * escrita la defensa correcta ("una suma parcial es una cota inferior: sostiene
 * «te pasaste» y jamás «te faltó»", engine.ts), pero esa guarda se dispara con
 * `isLowerBound`, y `isLowerBound` solo miraba si al VECTOR del día le faltaban
 * nutrientes. Nunca miró si al día le faltaban COMIDAS. La defensa estaba puesta
 * y nadie le avisaba, así que aguas abajo el sistema terminaba proponiendo
 * SUBIRLE los objetivos a alguien por no haber anotado un plato.
 *
 * La cobertura sí lo sabía todo el tiempo —mealRatio 0,67 y los tres días
 * marcados PARTIAL_LOG— pero ese dato moría en `coverage` y no llegaba al
 * número. Es el vacío leído como cero, con la ropa de un informe completo.
 *
 * Los tests van de a pares a propósito: cada uno que comprueba que el motor se
 * calla viene con su gemelo que comprueba que NO se calló de más. Un motor
 * mudo también pasaría la primera mitad.
 */

const OBJETIVO_KCAL = 2000;
const D3 = ["2026-08-05", "2026-08-06", "2026-08-07"] as const;
const HOY = "2026-08-07";

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

function metas(v: Partial<Record<GoalType, number>>): TargetSet {
  const set: TargetSet = {};
  for (const g of GOAL_TYPES) {
    const p = v[g];
    if (p !== undefined) set[g] = { minimum: 1600, preferred: p, maximum: 2200 };
  }
  return set;
}

const OBJETIVOS = metas({ ENERGY_KCAL: OBJETIVO_KCAL });
const POR_DIA = Object.fromEntries(D3.map((f) => [f, OBJETIVOS]));

/** Un día: `registradas` de tres comidas, con `kcal` en total. */
function unDia(fecha: string, registradas: number, kcal: number): DayIntake {
  return dia(fecha, {
    mealsExpected: 3,
    mealsLogged: registradas,
    actual: vector({ energy_kcal: kcal }),
  });
}

/** Tres días iguales: `registradas` de `mealsExpected`, con `kcal` en total. */
function tresDias(registradas: number, kcal: number): RollingBalance {
  return rollingBalance({
    window: "D3",
    endDate: HOY,
    days: D3.map((f) => unDia(f, registradas, kcal)),
    targetsByDate: POR_DIA,
  });
}

/**
 * Las dos ventanas que el motor adaptativo exige. Pide W24H sí o sí —"sin el
 * día no hay nada que explicar"— porque una recomendación que no puede decir
 * qué pasó HOY es una recomendación que la persona no puede contrastar.
 */
function ventanas(registradas: number, kcal: number): RollingBalance[] {
  return [
    rollingBalance({
      window: "W24H",
      endDate: HOY,
      days: [unDia(HOY, registradas, kcal)],
      targetsByDate: POR_DIA,
    }),
    tresDias(registradas, kcal),
  ];
}

const SIN_EVENTO: EventEffect = { kind: "NONE", event: null, text: "" };

function entradaAdaptativa(balances: readonly RollingBalance[]): AdaptiveInput {
  return {
    date: HOY,
    memberId: "m-1",
    trackingMode: "FULL",
    dailyTargets: OBJETIVOS,
    resolvedTargets: OBJETIVOS,
    eventEffect: SIN_EVENTO,
    balances: [...balances],
    clinicalContextResolved: true,
    clinicalCeilings: [],
    clinicalFloors: [],
    clinicalUnusableLimits: [],
    clinicalStatus: "COMPATIBLE",
    pendingClinicalReviews: 0,
    activeClinicalRestrictions: 0,
  };
}

describe("una comida sin registrar no es una comida sin comer", () => {
  it("el total de un día al que le faltan comidas es una COTA INFERIOR", () => {
    const r = tresDias(2, 1200);
    const e = r.balances.energy_kcal;

    expect(e.completeness, "un día con comidas sin registrar se declaró COMPLETO").toBe("PARTIAL");
    expect(e.isLowerBound, "la suma parcial no se marcó como piso").toBe(true);
    expect(e.confidence.reasons).toContain("NUTRIENT_LOWER_BOUND");

    // La cobertura ya lo sabía. Se comprueba para dejar claro que el dato
    // estaba, y que lo que faltaba era que llegara hasta el número.
    expect(r.coverage.mealRatio).toBeCloseTo(2 / 3, 6);
    expect(r.coverage.missing.map((m) => m.reason)).toEqual([
      "PARTIAL_LOG",
      "PARTIAL_LOG",
      "PARTIAL_LOG",
    ]);
  });

  it("y con TODAS las comidas registradas sigue siendo una medición completa", () => {
    // El gemelo: si el arreglo hubiera degradado todo a PARTIAL, el motor no
    // volvería a opinar nunca y este test lo delata.
    const e = tresDias(3, 2000).balances.energy_kcal;
    expect(e.completeness).toBe("COMPLETE");
    expect(e.isLowerBound).toBe(false);
    expect(e.delta).toBe(0);
  });

  it("el motor adaptativo NO propone subir objetivos por un almuerzo sin anotar", () => {
    // La cadena completa, que es lo que de verdad importa: el defecto no era
    // que un campo dijera COMPLETE, era que por decirlo se llegaba a tocarle
    // los objetivos a una persona.
    const review = reviewAdaptiveNutrition(entradaAdaptativa(ventanas(2, 1200)));

    expect(review.adjustments, "se propuso un ajuste sobre una suma parcial").toEqual([]);
    expect(review.reasons.map((r) => r.code)).toContain("LOWER_BOUND_CANNOT_SUSTAIN_DEFICIT");
    expect(review.missingData.length).toBeGreaterThan(0);
  });

  it("pero un EXCESO sostenido sobre una suma parcial sí se sostiene", () => {
    // Asimetría deliberada, y es la mitad que prueba que el arreglo no es
    // simplemente "callarse siempre": lo que falta por registrar solo puede
    // SUMAR, así que un piso ya por encima del rango sostiene la conclusión
    // "quedaste sobre el rango". Al revés no.
    const review = reviewAdaptiveNutrition(entradaAdaptativa(ventanas(2, 3000)));

    expect(
      review.reasons.map((r) => r.code),
      "un exceso sostenido se descartó por venir de una suma parcial",
    ).not.toContain("LOWER_BOUND_CANNOT_SUSTAIN_DEFICIT");
    expect(review.verdict).not.toBe("NO_CHANGE");
  });

  it("un día sin NINGUNA comida esperada no inventa un faltante", () => {
    // mealsExpected 0 es "el patrón de ese día no pide comidas", no "faltaron
    // todas". Si esto se rompe, cualquier día sin patrón declarado arrastraría
    // la ventana entera a cota inferior por una división que no existe.
    const r = rollingBalance({
      window: "D3",
      endDate: HOY,
      days: D3.map((f) =>
        dia(f, { mealsExpected: 0, mealsLogged: 0, actual: vector({ energy_kcal: 2000 }) }),
      ),
      targetsByDate: POR_DIA,
    });
    expect(r.balances.energy_kcal.isLowerBound).toBe(false);
    expect(r.coverage.mealRatio, "sin comidas esperadas no hay razón que calcular").toBeNull();
  });
});
