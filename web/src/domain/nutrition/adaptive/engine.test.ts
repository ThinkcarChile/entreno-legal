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
import type { ClinicalSeverity } from "@/domain/clinical/types";
import { addDays } from "@/domain/nutrition/calendar";
import type { EventEffect } from "@/domain/nutrition/events";
import type { GoalRange, TargetSet, TrackingMode } from "@/domain/nutrition/types";

import {
  rollingBalance,
  ROLLING_WINDOW_DAYS,
  type DayIntake,
  type RollingBalance,
  type RollingWindow,
} from "./rolling";
import {
  applyClinicalBounds,
  applyClinicalCeilings,
  applyClinicalFloors,
  reviewAdaptiveNutrition,
  unidadDeNutriente,
} from "./engine";
import {
  ADAPTIVE_ENGINE_VERSION,
  DEFAULT_ADAPTIVE_PARAMS,
  frozenAdaptiveConfig,
  type AdaptiveInput,
  type ClinicalCeiling,
  type ClinicalFloor,
} from "./types";

/**
 * La mitad del trabajo de este motor es NEGARSE a responder, así que la mitad
 * de estos tests prueban el camino donde no propone nada. La otra mitad ataca
 * la única invariante que no puede fallar nunca: que una propuesta adaptativa
 * ensanche un límite clínico.
 */

const HOY = "2026-08-20";
const RAIZ = path.resolve(__dirname, "../../../../..");

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

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

interface DiaSpec {
  valores?: Partial<Record<NutrientKey, number>>;
  parciales?: readonly NutrientKey[];
  mealsExpected?: number;
  mealsLogged?: number;
  isClosed?: boolean;
  skipTracking?: boolean;
  trackingMode?: TrackingMode;
  unknownQuantityItems?: number;
  /** El día existe pero nadie registró nada. */
  sinRegistro?: boolean;
  /** El día NO existe en la historia (persona nueva). */
  ausente?: boolean;
}

function ventana(
  w: RollingWindow,
  endDate: string,
  specs: readonly DiaSpec[],
  targets: TargetSet,
): RollingBalance {
  const largo = ROLLING_WINDOW_DAYS[w];
  if (specs.length !== largo) {
    throw new Error(`la ventana ${w} necesita ${largo} días y llegaron ${specs.length}`);
  }
  const start = addDays(endDate, -(largo - 1));
  const days: DayIntake[] = [];
  const targetsByDate: Record<string, TargetSet> = {};
  specs.forEach((s, i) => {
    const date = addDays(start, i);
    targetsByDate[date] = targets;
    if (s.ausente === true) return;
    const mealsExpected = s.mealsExpected === undefined ? 3 : s.mealsExpected;
    const mealsLogged = s.mealsLogged === undefined ? mealsExpected : s.mealsLogged;
    days.push({
      date,
      planned: null,
      served: null,
      actual: s.sinRegistro === true ? null : vector(s.valores === undefined ? {} : s.valores, s.parciales),
      mealsExpected,
      mealsServed: mealsLogged,
      mealsLogged,
      unassignedLogs: 0,
      unknownQuantityItems: s.unknownQuantityItems === undefined ? 0 : s.unknownQuantityItems,
      trackingMode: s.trackingMode === undefined ? "FULL" : s.trackingMode,
      skipTracking: s.skipTracking === undefined ? false : s.skipTracking,
      isClosed: s.isClosed === undefined ? true : s.isClosed,
    });
  });
  return rollingBalance({ window: w, endDate, days, targetsByDate });
}

/** W24H (el último día) + D3, que es la combinación normal de una revisión. */
function balancesD3(specs: readonly DiaSpec[], targets: TargetSet, endDate = HOY): RollingBalance[] {
  const ultimo = specs[specs.length - 1];
  if (ultimo === undefined) throw new Error("hacen falta días");
  return [ventana("W24H", endDate, [ultimo], targets), ventana("D3", endDate, specs, targets)];
}

const SIN_EVENTO: EventEffect = { kind: "NONE", event: null, text: "" };

function entrada(over: Partial<AdaptiveInput> = {}): AdaptiveInput {
  const objetivos: TargetSet = { ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 } };
  return {
    date: HOY,
    memberId: "m-1",
    trackingMode: "FULL",
    dailyTargets: objetivos,
    resolvedTargets: objetivos,
    eventEffect: SIN_EVENTO,
    balances: balancesD3([{ valores: { energy_kcal: 2400 } }, { valores: { energy_kcal: 2400 } }, { valores: { energy_kcal: 2400 } }], objetivos),
    clinicalContextResolved: true,
    clinicalCeilings: [],
    clinicalFloors: [],
    clinicalUnusableLimits: [],
    clinicalStatus: "COMPATIBLE",
    pendingClinicalReviews: 0,
    activeClinicalRestrictions: 0,
    ...over,
  };
}

/** Déficit sostenido de −20%: el que EMPUJA HACIA ARRIBA y por eso hay que acotar. */
function deficitInput(over: Partial<AdaptiveInput> = {}): AdaptiveInput {
  const objetivos: TargetSet = { ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 } };
  return entrada({
    resolvedTargets: objetivos,
    dailyTargets: objetivos,
    balances: balancesD3(
      [{ valores: { energy_kcal: 1600 } }, { valores: { energy_kcal: 1600 } }, { valores: { energy_kcal: 1600 } }],
      objetivos,
    ),
    ...over,
  });
}

function techo(nutrient: NutrientKey, max: number | null, over: Partial<ClinicalCeiling> = {}): ClinicalCeiling {
  return {
    nutrient,
    max,
    unit: unidadDeNutriente(nutrient),
    restrictionId: "r-techo",
    severity: "HARD",
    ...over,
  };
}

function piso(nutrient: NutrientKey, min: number | null, over: Partial<ClinicalFloor> = {}): ClinicalFloor {
  return {
    nutrient,
    min,
    unit: unidadDeNutriente(nutrient),
    restrictionId: "r-piso",
    severity: "HARD",
    ...over,
  };
}

function fuente(archivo: string): string {
  return readFileSync(path.join(__dirname, archivo), "utf8");
}

/** El cuerpo de una función exportada, sin el comentario de la siguiente. */
function cuerpoDe(nombre: string): string {
  const src = fuente("engine.ts");
  const desde = src.indexOf(`export function ${nombre}(`);
  expect(desde, `no se encontró ${nombre}`).toBeGreaterThan(-1);
  // El corte es la llave de cierre en columna 0. Se busca "\n}" y no "\n}\n"
  // porque el archivo puede venir con fin de línea de Windows.
  const hasta = src.indexOf("\n}", desde);
  expect(hasta).toBeGreaterThan(desde);
  return src.slice(desde, hasta);
}

// ---------------------------------------------------------------------------
// LO CLÍNICO ES COTA, NO SUGERENCIA
// ---------------------------------------------------------------------------

describe("applyClinicalCeilings — es imposible ensanchar un techo clínico", () => {
  it("compone SOLO con Math.min: no hay un Math.max en su cuerpo", () => {
    const cuerpo = cuerpoDe("applyClinicalCeilings");
    expect(cuerpo.includes("Math.max"), "applyClinicalCeilings usa Math.max").toBe(false);
    expect(cuerpo.includes("Math.min")).toBe(true);
    // Y la mitad simétrica, al revés: un piso no puede recortar un techo.
    const piso = cuerpoDe("applyClinicalFloors");
    expect(piso.includes("Math.min"), "applyClinicalFloors usa Math.min").toBe(false);
    expect(piso.includes("Math.max")).toBe(true);
  });

  it("ninguna combinación de propuesta y techos deja un borde sobre el techo", () => {
    const propuestas: GoalRange[] = [];
    for (const minimum of [null, 0, 50, 100, 3000]) {
      for (const preferred of [null, 60, 120, 2500]) {
        for (const maximum of [null, 70, 130, 9000]) {
          propuestas.push({ minimum, preferred, maximum });
        }
      }
    }
    const juegos: ClinicalCeiling[][] = [
      [techo("protein_g", 100)],
      [techo("protein_g", 0)],
      [techo("protein_g", 100), techo("protein_g", 60, { restrictionId: "r-2" })],
      [techo("protein_g", 60, { restrictionId: "r-2" }), techo("protein_g", 100)],
      [techo("protein_g", 100, { severity: "INFO" as ClinicalSeverity })],
      [techo("protein_g", 1e12)],
      [techo("energy_kcal", 1)], // otro nutriente: no puede ensanchar el de acá
      [techo("protein_g", 100), techo("energy_kcal", 1)],
    ];
    for (const propuesta of propuestas) {
      for (const juego of juegos) {
        const r = applyClinicalCeilings(propuesta, juego, "protein_g");
        if (r.range === null) {
          expect(r.blockedBy).not.toBeNull();
          continue;
        }
        const cota = Math.min(...juego.filter((c) => c.nutrient === "protein_g").map((c) => c.max as number));
        for (const borde of ["minimum", "preferred", "maximum"] as const) {
          const v = r.range[borde];
          if (v === null || !Number.isFinite(cota)) continue;
          expect(v, `${borde} quedó sobre el techo`).toBeLessThanOrEqual(cota);
        }
        // Y nunca ENSANCHA: ningún borde declarado sale más alto que como entró.
        if (propuesta.maximum !== null && r.range.maximum !== null) {
          expect(r.range.maximum).toBeLessThanOrEqual(propuesta.maximum);
        }
        if (propuesta.preferred !== null && r.range.preferred !== null) {
          expect(r.range.preferred).toBeLessThanOrEqual(propuesta.preferred);
        }
      }
    }
  });

  it("un techo sin cifra o en otra unidad BLOQUEA; jamás se descarta la cota", () => {
    const propuesta: GoalRange = { minimum: 50, preferred: 100, maximum: 130 };
    const sinCifra = applyClinicalCeilings(propuesta, [techo("protein_g", null)], "protein_g");
    expect(sinCifra.range).toBeNull();
    expect(sinCifra.blockedBy).toBe("CLINICAL_LIMIT_UNUSABLE");

    const otraUnidad = applyClinicalCeilings(
      propuesta,
      [techo("sodium_mg", 2, { unit: "g" })],
      "sodium_mg",
    );
    expect(otraUnidad.range).toBeNull();
    expect(otraUnidad.blockedBy).toBe("CLINICAL_LIMIT_UNUSABLE");
  });

  it("el techo bajo el mínimo declarado descarta el ajuste entero, no baja el mínimo", () => {
    const r = applyClinicalCeilings({ minimum: 90, preferred: 100, maximum: 130 }, [techo("protein_g", 80)], "protein_g");
    expect(r.range).toBeNull();
    expect(r.blockedBy).toBe("CLINICAL_CEILING_BLOCKS_PROPOSAL");
    expect(r.overrides.map((o) => o.restrictionId)).toEqual(["r-techo"]);
  });

  it("el preferido se re-encaja DESPUÉS del techo, nunca queda sobre él", () => {
    const r = applyClinicalBounds({ minimum: 50, preferred: 90, maximum: 120 }, [techo("protein_g", 70)], [], "protein_g");
    expect(r.range).not.toBeNull();
    expect(r.range?.maximum).toBe(70);
    expect(r.range?.preferred).toBe(70);
    expect(r.range?.minimum).toBe(50);
  });

  it("el piso clínico sube el mínimo y jamás sube el máximo", () => {
    const r = applyClinicalFloors({ minimum: 50, preferred: 60, maximum: 120 }, [piso("protein_g", 80)], "protein_g");
    expect(r.range).toEqual({ minimum: 80, preferred: 80, maximum: 120 });
    const bloqueado = applyClinicalFloors({ minimum: 10, preferred: 20, maximum: 30 }, [piso("protein_g", 80)], "protein_g");
    expect(bloqueado.range).toBeNull();
    expect(bloqueado.blockedBy).toBe("CLINICAL_FLOOR_BLOCKS_PROPOSAL");
  });
});

describe("el motor completo respeta el techo clínico por todos los caminos", () => {
  it("un déficit sostenido que empujaría +10% se recorta al techo, y lo declara", () => {
    const sinTecho = reviewAdaptiveNutrition(deficitInput());
    expect(sinTecho.adjustments).toHaveLength(1);
    expect(sinTecho.adjustments[0]?.to.maximum).toBe(2420);

    const conTecho = reviewAdaptiveNutrition(deficitInput({ clinicalCeilings: [techo("energy_kcal", 2100)] }));
    const ajuste = conTecho.adjustments[0];
    expect(ajuste?.to.maximum).toBe(2100);
    expect(ajuste?.to.preferred).toBeLessThanOrEqual(2100);
    expect(ajuste?.cappedBy).toContain("CLINICAL_CEILING");
    expect(conTecho.clinicalOverrides).toEqual([
      { restrictionId: "r-techo", nutrient: "energy_kcal", kind: "CEILING", cappedAt: 2100 },
    ]);
  });

  it("subir la severidad o el número del techo nunca ensancha la salida", () => {
    // ESCALA TOTAL, para que el caso bloqueado también afirme algo: un ajuste
    // que no se propone es MÁS APRETADO que cualquier número, y se codifica
    // como −1. Antes ese caso se salteaba con un `continue` y la única
    // afirmación que quedaba (`ancho <= 2420`) era el tope de PARÁMETROS, no el
    // techo clínico: borrar la composición clínica entera dejaba este test
    // igual de verde.
    const anchoDe = (max: number): number => {
      const r = reviewAdaptiveNutrition(deficitInput({ clinicalCeilings: [techo("energy_kcal", max)] }));
      const ajuste = r.adjustments[0];
      if (ajuste === undefined) {
        expect(r.verdict, `el techo ${max} no propuso nada y tampoco subió a revisión`).toBe("REVIEW_REQUIRED");
        return -1;
      }
      const maximo = ajuste.to.maximum;
      expect(maximo, `el techo ${max} propuso un ajuste sin máximo`).not.toBeNull();
      return maximo === null ? -1 : maximo;
    };

    const techos = [1500, 2000, 2100, 2400, 999999];
    const anchos = techos.map(anchoDe);

    // 1. MONOTONÍA, que es lo que el título promete: un techo más alto nunca
    //    devuelve una salida más apretada.
    for (let i = 1; i < anchos.length; i += 1) {
      expect(
        anchos[i]!,
        `subir el techo de ${techos[i - 1]} a ${techos[i]} apretó la salida`,
      ).toBeGreaterThanOrEqual(anchos[i - 1]!);
    }
    // 2. Y CADA SALIDA QUEDA BAJO SU PROPIO TECHO. Ésta es la mitad que muere
    //    si alguien borra la llamada a `applyClinicalBounds`: sin ella los
    //    cinco casos salen en 2420 y los techos 2000/2100/2400 quedan violados.
    techos.forEach((max, i) => {
      const ancho = anchos[i]!;
      if (ancho < 0) return;
      expect(ancho, `la salida quedó sobre el techo clínico de ${max}`).toBeLessThanOrEqual(max);
    });
    // 3. Al menos un techo tiene que MORDER de verdad: si todos salieran en el
    //    tope de parámetros, este test estaría mirando otra cosa.
    expect(
      anchos.some((a) => a >= 0 && a < 2420),
      "ningún techo recortó nada: el test dejó de probar el techo",
    ).toBe(true);
    expect(Math.max(...anchos), "el tope de parámetros dejó de acotar").toBeLessThanOrEqual(2420);

    const severidades: ClinicalSeverity[] = ["INFO", "CAUTION", "HARD", "CRITICAL_REVIEW"];
    const salidas = severidades.map((severity) =>
      JSON.stringify(
        reviewAdaptiveNutrition(deficitInput({ clinicalCeilings: [techo("energy_kcal", 2100, { severity })] }))
          .adjustments,
      ),
    );
    expect(new Set(salidas).size, "la severidad cambió el número propuesto").toBe(1);
    // Las cuatro salidas iguales tienen que ser iguales EN EL TECHO (2100) y no
    // en el tope de parámetros (2420): ignorar los techos también produce
    // cuatro salidas idénticas.
    for (const severity of severidades) {
      const r = reviewAdaptiveNutrition(
        deficitInput({ clinicalCeilings: [techo("energy_kcal", 2100, { severity })] }),
      );
      expect(r.adjustments[0]?.to.maximum, `la severidad ${severity} ignoró el techo`).toBe(2100);
    }
  });

  it("el techo bajo el mínimo declarado deja REVIEW_REQUIRED y CERO ajustes", () => {
    const r = reviewAdaptiveNutrition(deficitInput({ clinicalCeilings: [techo("energy_kcal", 1500)] }));
    expect(r.verdict).toBe("REVIEW_REQUIRED");
    expect(r.adjustments).toEqual([]);
    expect(r.reasons.map((x) => x.code)).toContain("CLINICAL_CEILING_BLOCKS_PROPOSAL");
  });

  it("un techo CONFIRMADO sin cifra bloquea el nutriente entero", () => {
    const r = reviewAdaptiveNutrition(deficitInput({ clinicalCeilings: [techo("energy_kcal", null)] }));
    expect(r.verdict).toBe("REVIEW_REQUIRED");
    expect(r.adjustments).toEqual([]);
    expect(r.reasons.map((x) => x.code)).toContain("CLINICAL_LIMIT_UNUSABLE");
  });

  it("una cota que la BASE marcó inservible también bloquea, aunque no venga entre los techos", () => {
    const r = reviewAdaptiveNutrition(
      deficitInput({
        clinicalUnusableLimits: [
          {
            nutrient: "energy_kcal",
            restrictionId: "r-x",
            why: "LIMIT_WITHOUT_VALUE",
            unit: null,
            expectedUnit: "kcal",
          },
        ],
      }),
    );
    expect(r.verdict).toBe("REVIEW_REQUIRED");
    expect(r.adjustments).toEqual([]);
  });

  it("un mínimo clínico de proteína no se cruza cuando el superávit propone apretar", () => {
    const objetivos: TargetSet = {
      PROTEIN_G: { minimum: 90, preferred: 100, maximum: 130 },
    };
    const dias = [
      { valores: { protein_g: 120 } },
      { valores: { protein_g: 120 } },
      { valores: { protein_g: 120 } },
    ];
    const base = entrada({
      dailyTargets: objetivos,
      resolvedTargets: objetivos,
      balances: balancesD3(dias, objetivos),
    });
    const sinPiso = reviewAdaptiveNutrition(base);
    expect(sinPiso.adjustments[0]?.to.preferred).toBe(90);

    const conPiso = reviewAdaptiveNutrition({ ...base, clinicalFloors: [piso("protein_g", 95)] });
    const ajuste = conPiso.adjustments[0];
    expect(ajuste?.to.minimum).toBeGreaterThanOrEqual(95);
    expect(ajuste?.to.preferred).toBeGreaterThanOrEqual(95);
    expect(ajuste?.cappedBy).toContain("CLINICAL_FLOOR");
  });
});

// ---------------------------------------------------------------------------
// DEFECTO ABIERTO EN engine.ts — NO SE INVENTA UNA INDICACIÓN DE SALUD
// ---------------------------------------------------------------------------

/**
 * ESTOS DOS TESTS ESTÁN EN ROJO A PROPÓSITO. Prueban un defecto vivo de
 * `engine.ts`, archivo que este agente NO puede editar en esta corrida. Un test
 * rojo que nombra el defecto vale más que un silencio verde: cuando alguien
 * arregle `applyClinicalBounds`, se ponen solos en verde y se quedan de
 * guardia.
 *
 * QUÉ PASA HOY: `applyClinicalBounds` (engine.ts:335) devuelve
 * `blockedBy: "CLINICAL_CEILING_BLOCKS_PROPOSAL"` cuando el rango compuesto
 * queda con `minimum > maximum`, AUNQUE las dos listas clínicas vengan vacías.
 * Ese desorden no lo produce ninguna cota de salud: lo produce el tope de
 * parámetros (`maxDecreaseRatio` 0,9 aplicado al máximo) chocando con
 * `minimumFloorPolicy`, que sostiene el mínimo declarado. Pasa con cualquier
 * objetivo angosto (maximum/minimum < 1,111), que es lo NORMAL en proteína o
 * fibra.
 *
 * POR QUÉ IMPORTA: `bloqueoClinico` vacía TODOS los ajustes de la revisión
 * —también los de otros nutrientes—, el veredicto queda REVIEW_REQUIRED y la
 * superficie del hogar le muestra a una familia sin un solo dato clínico la
 * frase «Una indicación de salud no deja espacio para este ajuste. Lo revisa
 * una persona». Es una afirmación médica fabricada.
 *
 * ARREGLO PEDIDO, en engine.ts: cuando NO hay ninguna cota usable ni ninguna
 * cota inservible para ese nutriente, el conflicto `minimum > maximum` es un
 * conflicto de PARÁMETROS. Tiene que salir por un código propio (del orden de
 * ADJUSTMENT_CAPPED_BY_PARAMS / FLOOR_MINIMUM_ENFORCED), descartar sólo ese
 * nutriente y NO prender `bloqueoClinico`.
 */
describe("no se inventa una indicación de salud donde no hay ninguna", () => {
  it("con las dos listas clínicas VACÍAS, un rango angosto no puede salir como bloqueo clínico", () => {
    // {30, 27, 27} es exactamente lo que deja el tope de parámetros sobre un
    // objetivo de fibra angosto: mínimo declarado 30 y máximo apretado a 27.
    const sinNadaClinico = applyClinicalBounds({ minimum: 30, preferred: 27, maximum: 27 }, [], [], "fiber_g");
    expect(
      sinNadaClinico.blockedBy,
      "engine.ts:335 llama CLINICAL_CEILING_BLOCKS_PROPOSAL a un conflicto de PARÁMETROS: " +
        "ceilings=[] y floors=[], no hay ninguna restricción clínica. ARREGLO: sin cotas usables ni " +
        "inservibles para el nutriente, el desorden minimum>maximum sale con un código de parámetros " +
        "y no prende bloqueoClinico.",
    ).not.toBe("CLINICAL_CEILING_BLOCKS_PROPOSAL");
    expect(sinNadaClinico.range, "el ajuste igual se descarta: lo que no puede es llamarse clínico").toBeNull();
    expect(sinNadaClinico.overrides, "no hay ninguna cota que citar").toEqual([]);
  });

  it("a una familia sin ningún dato clínico no se le dice que una indicación de salud la bloqueó", () => {
    // Objetivo angosto y normalísimo de proteína, y tres días 24 % arriba.
    const objetivos: TargetSet = { PROTEIN_G: { minimum: 100, preferred: 105, maximum: 110 } };
    const dias: DiaSpec[] = [
      { valores: { protein_g: 130 } },
      { valores: { protein_g: 130 } },
      { valores: { protein_g: 130 } },
    ];
    const r = reviewAdaptiveNutrition(
      entrada({
        resolvedTargets: objetivos,
        dailyTargets: objetivos,
        balances: balancesD3(dias, objetivos),
        // Cero restricciones, contexto leído y compatible: no hay NADA clínico.
        clinicalCeilings: [],
        clinicalFloors: [],
        clinicalUnusableLimits: [],
        clinicalStatus: "COMPATIBLE",
        activeClinicalRestrictions: 0,
        pendingClinicalReviews: 0,
      }),
    );
    const codigos = r.reasons.map((x) => x.code);
    expect(
      codigos,
      "el motor emite una razón CLÍNICA con activeClinicalRestrictions=0 y las tres listas clínicas vacías: " +
        "la persona lee «una indicación de salud no deja espacio para este ajuste» sin tener ninguna. " +
        "ARREGLO en engine.ts (ver applyClinicalBounds, engine.ts:335).",
    ).not.toContain("CLINICAL_CEILING_BLOCKS_PROPOSAL");
    expect(r.clinicalOverrides, "no hay ninguna cota que haya recortado nada").toEqual([]);
  });
});

describe("el canal clínico ilegible se calla; un arreglo vacío no es 'no hay restricciones'", () => {
  it("con el contexto sin resolver: REVIEW_REQUIRED y cero ajustes", () => {
    const r = reviewAdaptiveNutrition(deficitInput({ clinicalContextResolved: false }));
    expect(r.verdict).toBe("REVIEW_REQUIRED");
    expect(r.adjustments).toEqual([]);
    expect(r.reasons.map((x) => x.code)).toContain("CLINICAL_CONTEXT_UNRESOLVED");
  });

  it("con los contadores en null tampoco opina: null no es cero", () => {
    for (const over of [{ pendingClinicalReviews: null }, { activeClinicalRestrictions: null }]) {
      const r = reviewAdaptiveNutrition(deficitInput(over));
      expect(r.verdict).toBe("REVIEW_REQUIRED");
      expect(r.adjustments).toEqual([]);
    }
  });

  it("con una revisión de salud PENDIENTE el motor se calla", () => {
    const r = reviewAdaptiveNutrition(deficitInput({ pendingClinicalReviews: 1 }));
    expect(r.verdict).toBe("REVIEW_REQUIRED");
    expect(r.adjustments).toEqual([]);
    expect(r.reasons.map((x) => x.code)).toContain("CLINICAL_REVIEW_PENDING");
  });

  it("con restricciones vigentes y el día sin evaluar, 'no evaluada' no pasa por 'compatible'", () => {
    for (const clinicalStatus of [null, "NOT_ASSESSED"] as const) {
      const r = reviewAdaptiveNutrition(deficitInput({ activeClinicalRestrictions: 2, clinicalStatus }));
      expect(r.verdict).toBe("REVIEW_REQUIRED");
      expect(r.adjustments).toEqual([]);
      expect(r.reasons.map((x) => x.code)).toContain("CLINICAL_STATUS_UNKNOWN");
    }
  });

  it("un veredicto clínico que bloquea gana antes que cualquier cuenta", () => {
    for (const clinicalStatus of ["CLINICALLY_INVALIDATED", "REVIEW_REQUIRED"] as const) {
      const r = reviewAdaptiveNutrition(deficitInput({ clinicalStatus }));
      expect(r.verdict).toBe("REVIEW_REQUIRED");
      expect(r.adjustments).toEqual([]);
    }
  });

  it("con y sin permiso para leer lo clínico, jamás sale un ajuste MÁS ANCHO", () => {
    const conPermiso = reviewAdaptiveNutrition(deficitInput({ clinicalCeilings: [techo("energy_kcal", 2100)] }));
    const sinPermiso = reviewAdaptiveNutrition(
      deficitInput({ clinicalContextResolved: false, clinicalCeilings: [] }),
    );
    expect(sinPermiso.adjustments.length).toBeLessThanOrEqual(conPermiso.adjustments.length);
    expect(sinPermiso.adjustments).toEqual([]);
  });
});

describe("privacidad: la superficie del hogar no publica la condición", () => {
  it("ninguna razón clínica nombra un nutriente ni una cifra, y ningún id viaja en reasons/missingData", () => {
    const r = reviewAdaptiveNutrition(
      deficitInput({ clinicalCeilings: [techo("energy_kcal", 2100, { restrictionId: "restriccion-secreta" })] }),
    );
    for (const razon of r.reasons) {
      if (!razon.code.startsWith("CLINICAL_")) continue;
      expect(razon.nutrient, `${razon.code} nombra un nutriente`).toBeNull();
      expect(/\d/.test(razon.text), `${razon.code} lleva una cifra en el texto`).toBe(false);
    }
    const superficie = JSON.stringify({ reasons: r.reasons, missingData: r.missingData });
    expect(superficie.includes("restriccion-secreta")).toBe(false);
    // El detalle sí existe, pero en el canal médico.
    expect(JSON.stringify(r.clinicalOverrides).includes("restriccion-secreta")).toBe(true);
  });

  it("declara los techos que NO pudo verificar en vez de dejar clinicalOverrides vacío en silencio", () => {
    const r = reviewAdaptiveNutrition(
      deficitInput({ clinicalCeilings: [techo("sodium_mg", 2000, { restrictionId: "r-na" })] }),
    );
    expect(r.unverifiedCeilings).toEqual([
      { restrictionId: "r-na", nutrient: "sodium_mg", reason: "NO_GOAL_TYPE_FOR_NUTRIENT" },
    ]);
    // Un techo que nadie verificó no puede sostener una RECOMENDACIÓN de subir.
    expect(r.verdict).toBe("OPTIONAL_ADJUSTMENT");
    expect(r.reasons.map((x) => x.code)).toContain("CLINICAL_CEILING_UNVERIFIED");
  });
});

// ---------------------------------------------------------------------------
// EL TIPO NO PUEDE EXPRESAR "SÁLTATE UNA COMIDA" NI "QUEMA LO COMIDO"
// ---------------------------------------------------------------------------

describe("lo que el contrato hace imposible", () => {
  it("un ajuste emitido tiene EXACTAMENTE estas claves y ninguna habla de comidas ni de ejercicio", () => {
    const r = reviewAdaptiveNutrition(deficitInput());
    const ajuste = r.adjustments[0];
    expect(ajuste).toBeDefined();
    expect(Object.keys(ajuste as object).sort()).toEqual(
      ["cappedBy", "from", "goalType", "nutrient", "reasonCode", "scope", "to", "validFrom", "validUntil", "window"].sort(),
    );
    expect(ajuste?.scope).toBe("TEMPORARY_DAY");
    expect(Object.keys(ajuste?.to as object).sort()).toEqual(["maximum", "minimum", "preferred"]);
  });

  it("ni el tipo ni el motor pueden nombrar una comida, un enabled ni un gasto energético", () => {
    const tipos = fuente("types.ts");
    const bloque = tipos.slice(
      tipos.indexOf("export interface AdaptiveAdjustment"),
      tipos.indexOf("export interface AdaptiveMissingData"),
    );
    expect(bloque.length).toBeGreaterThan(100);
    const prohibido = /mealType|meal_type|enabled|activity|exercise|expenditure|burn|fasting|skip/i;
    expect(prohibido.test(bloque), "AdaptiveAdjustment puede expresar saltarse una comida").toBe(false);

    // Y en TODO el motor no existe una sola mención a actividad o gasto.
    const motor = fuente("engine.ts");
    expect(/\b(activityLevel|caloriesBurned|exercise|tdee|expenditure)\b/i.test(motor)).toBe(false);
  });

  it("NO_FASTING_ALLOWED y NO_ACTIVITY_COMPENSATION existen en el contrato y ninguna regla los emite", () => {
    const motor = fuente("engine.ts");
    expect(motor.includes('agregarRazon(acc, "NO_FASTING_ALLOWED"')).toBe(false);
    expect(motor.includes('agregarRazon(acc, "NO_ACTIVITY_COMPENSATION"')).toBe(false);
  });

  it("todo ajuste es temporal, nunca retroactivo y nunca más allá del tope de vigencia", () => {
    const r = reviewAdaptiveNutrition(deficitInput());
    expect(r.adjustments.length, "sin ajustes este test no mira nada").toBeGreaterThan(0);
    for (const a of r.adjustments) {
      expect(a.validFrom).toBe(HOY);
      // EXACTO, no "menor o igual": `maxValidityDays` cuenta DÍAS VIVIDOS —hoy,
      // mañana y pasado—, así que el último día es `validFrom + 2`. La cota
      // floja de +3 que había acá dejaba pasar justo el corrimiento de un día
      // que decía vigilar.
      expect(a.validUntil).toBe(addDays(a.validFrom, DEFAULT_ADAPTIVE_PARAMS.maxValidityDays - 1));
      expect(a.validUntil >= a.validFrom).toBe(true);
      expect(a.window).not.toBe("W24H");
    }

    // Y la vigencia SALE DE LOS PARÁMETROS, no de una constante escrita al
    // lado: con otro tope, la ventana se mueve con él.
    const conParams = reviewAdaptiveNutrition({
      ...deficitInput(),
      params: { ...DEFAULT_ADAPTIVE_PARAMS, maxValidityDays: 5 },
    });
    expect(conParams.adjustments.length).toBeGreaterThan(0);
    for (const a of conParams.adjustments) {
      expect(a.validUntil).toBe(addDays(a.validFrom, 4));
    }
  });
});

// ---------------------------------------------------------------------------
// UN DÍA INCOMPLETO NO PRODUCE UNA RECOMENDACIÓN DÉBIL
// ---------------------------------------------------------------------------

describe("cuando falta información, el motor dice qué faltó", () => {
  it("cobertura bajo el mínimo ⇒ INSUFFICIENT_DATA con missingData, no una propuesta tibia", () => {
    const objetivos: TargetSet = { ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 } };
    const dias: DiaSpec[] = [
      { valores: { energy_kcal: 800 }, mealsLogged: 1 },
      { valores: { energy_kcal: 800 }, mealsLogged: 1 },
      { valores: { energy_kcal: 800 }, mealsLogged: 1 },
    ];
    const r = reviewAdaptiveNutrition(
      entrada({ resolvedTargets: objetivos, dailyTargets: objetivos, balances: balancesD3(dias, objetivos) }),
    );
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.adjustments).toEqual([]);
    expect(r.missingData.length).toBeGreaterThan(0);
    expect(r.missingData.every((m) => m.detail.length > 0)).toBe(true);
    expect(r.reasons.map((x) => x.code)).toContain("DATA_COVERAGE_INSUFFICIENT");
  });

  it("días que no existen en la historia se declaran uno por uno", () => {
    const objetivos: TargetSet = { ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 } };
    const dias: DiaSpec[] = [{ ausente: true }, { ausente: true }, { valores: { energy_kcal: 2400 }, mealsLogged: 1 }];
    const r = reviewAdaptiveNutrition(
      entrada({ resolvedTargets: objetivos, dailyTargets: objetivos, balances: balancesD3(dias, objetivos) }),
    );
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    const ausentes = r.missingData.filter((m) => m.kind === "DAY" && m.detail.includes("NOT_IN_HISTORY"));
    expect(ausentes).toHaveLength(2);
  });

  it("sin objetivo declarado no se inventa un borde", () => {
    const objetivos: TargetSet = {};
    const dias: DiaSpec[] = [
      { valores: { energy_kcal: 2400 } },
      { valores: { energy_kcal: 2400 } },
      { valores: { energy_kcal: 2400 } },
    ];
    const r = reviewAdaptiveNutrition(
      entrada({ resolvedTargets: objetivos, dailyTargets: objetivos, balances: balancesD3(dias, objetivos) }),
    );
    expect(r.adjustments).toEqual([]);
    expect(r.reasons.map((x) => x.code)).toContain("NO_TARGET_DECLARED");
  });

  it("una suma PARCIAL jamás sostiene una conclusión de déficit", () => {
    const objetivos: TargetSet = { PROTEIN_G: { minimum: 90, preferred: 130, maximum: 160 } };
    const dias: DiaSpec[] = [
      { valores: { protein_g: 90 }, parciales: ["protein_g"] },
      { valores: { protein_g: 90 }, parciales: ["protein_g"] },
      { valores: { protein_g: 90 }, parciales: ["protein_g"] },
    ];
    const r = reviewAdaptiveNutrition(
      entrada({ resolvedTargets: objetivos, dailyTargets: objetivos, balances: balancesD3(dias, objetivos) }),
    );
    expect(r.adjustments).toEqual([]);
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.reasons.map((x) => x.code)).toContain("LOWER_BOUND_CANNOT_SUSTAIN_DEFICIT");
    expect(r.missingData.some((m) => m.detail.includes("cota inferior"))).toBe(true);
  });

  it("pero una suma PARCIAL sí sostiene 'quedaste sobre el rango': lo que falta solo puede sumar", () => {
    const objetivos: TargetSet = { PROTEIN_G: { minimum: 90, preferred: 100, maximum: 130 } };
    const dias: DiaSpec[] = [
      { valores: { protein_g: 130 }, parciales: ["protein_g"] },
      { valores: { protein_g: 130 }, parciales: ["protein_g"] },
      { valores: { protein_g: 130 }, parciales: ["protein_g"] },
    ];
    const r = reviewAdaptiveNutrition(
      entrada({ resolvedTargets: objetivos, dailyTargets: objetivos, balances: balancesD3(dias, objetivos) }),
    );
    expect(r.adjustments).toHaveLength(1);
    expect(r.reasons.map((x) => x.code)).toContain("NUTRIENT_PARTIAL");
  });

  it("el seguimiento apagado no es 'todo en orden'", () => {
    const r = reviewAdaptiveNutrition(deficitInput({ trackingMode: "OFF" }));
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.adjustments).toEqual([]);
  });

  it("un día marcado sin conteo no genera compensación al día siguiente", () => {
    const r = reviewAdaptiveNutrition(
      deficitInput({
        eventEffect: {
          kind: "UNTRACKED",
          event: null,
          text: "Sin conteo.",
        },
      }),
    );
    expect(r.verdict).toBe("NO_CHANGE");
    expect(r.adjustments).toEqual([]);
    expect(r.reasons.map((x) => x.code)).toContain("DAY_UNTRACKED_BY_EVENT");
  });
});

// ---------------------------------------------------------------------------
// ANTI-COMPENSACIÓN
// ---------------------------------------------------------------------------

describe("los topes son estructurales, no buenas intenciones", () => {
  it("ningún borde se mueve más de ±10%, con CUALQUIER combinación de bordes nulos", () => {
    const combinaciones: GoalRange[] = [];
    for (const minimum of [null, 1600]) {
      for (const maximum of [null, 2200]) {
        combinaciones.push({ minimum, preferred: 2000, maximum });
      }
    }
    for (const from of combinaciones) {
      for (const kcalPorDia of [1000, 1600, 2400, 5000]) {
        const objetivos: TargetSet = { ENERGY_KCAL: from };
        const dias: DiaSpec[] = [
          { valores: { energy_kcal: kcalPorDia } },
          { valores: { energy_kcal: kcalPorDia } },
          { valores: { energy_kcal: kcalPorDia } },
        ];
        const r = reviewAdaptiveNutrition(
          entrada({ resolvedTargets: objetivos, dailyTargets: objetivos, balances: balancesD3(dias, objetivos) }),
        );
        for (const a of r.adjustments) {
          for (const borde of ["minimum", "preferred", "maximum"] as const) {
            const antes = from[borde];
            const despues = a.to[borde];
            if (antes === null || despues === null) continue;
            expect(despues, `${borde} bajó más de un 10%`).toBeGreaterThanOrEqual(
              antes * DEFAULT_ADAPTIVE_PARAMS.maxDecreaseRatio,
            );
            expect(despues, `${borde} subió más de un 10%`).toBeLessThanOrEqual(
              antes * DEFAULT_ADAPTIVE_PARAMS.maxIncreaseRatio,
            );
          }
          // El mínimo declarado NUNCA baja, aunque el apriete lo permitiera.
          if (from.minimum !== null && a.to.minimum !== null) {
            expect(a.to.minimum).toBeGreaterThanOrEqual(from.minimum);
          }
          // Y el rango siempre sale ordenado.
          const { minimum, preferred, maximum } = a.to;
          if (minimum !== null && preferred !== null) expect(minimum).toBeLessThanOrEqual(preferred);
          if (preferred !== null && maximum !== null) expect(preferred).toBeLessThanOrEqual(maximum);
        }
      }
    }
  });

  it("un DÉFICIT jamás baja un borde: apretar después de comer de menos no es proponible", () => {
    const r = reviewAdaptiveNutrition(deficitInput());
    expect(r.adjustments).toHaveLength(1);
    const a = r.adjustments[0];
    expect(a?.reasonCode).toBe("SUSTAINED_DEFICIT");
    for (const borde of ["minimum", "preferred", "maximum"] as const) {
      const antes = a?.from[borde];
      const despues = a?.to[borde];
      if (antes === null || antes === undefined || despues === null || despues === undefined) continue;
      expect(despues).toBeGreaterThanOrEqual(antes);
    }
  });

  it("un subconsumo sostenido sube a una persona SIN ajuste, no se convierte en recomendación", () => {
    const objetivos: TargetSet = { ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 } };
    const dias: DiaSpec[] = [
      { valores: { energy_kcal: 0 } },
      { valores: { energy_kcal: 0 } },
      { valores: { energy_kcal: 0 } },
    ];
    const r = reviewAdaptiveNutrition(
      entrada({ resolvedTargets: objetivos, dailyTargets: objetivos, balances: balancesD3(dias, objetivos) }),
    );
    expect(r.verdict).toBe("REVIEW_REQUIRED");
    expect(r.adjustments).toEqual([]);
    expect(r.reasons.map((x) => x.code)).toContain("SUSTAINED_UNDEREATING");
  });

  it("un solo día atípico no llega a la bandeja con un botón de aplicar", () => {
    // El asado del sábado: +15% ese día, y la ventana de tres días queda dentro
    // de la banda de ruido. La ventana manda; el día solo explica.
    const objetivos: TargetSet = { ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 } };
    const dias: DiaSpec[] = [
      { valores: { energy_kcal: 1900 } },
      { valores: { energy_kcal: 1900 } },
      { valores: { energy_kcal: 2300 } },
    ];
    const r = reviewAdaptiveNutrition(
      entrada({ resolvedTargets: objetivos, dailyTargets: objetivos, balances: balancesD3(dias, objetivos) }),
    );
    expect(r.adjustments).toEqual([]);
    expect(r.reasons.map((x) => x.code)).toContain("SINGLE_DAY_DEVIATION");
  });

  it("con solo la ventana de 24 horas no se sostiene ningún ajuste", () => {
    const objetivos: TargetSet = { ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 } };
    const r = reviewAdaptiveNutrition(
      entrada({
        resolvedTargets: objetivos,
        dailyTargets: objetivos,
        balances: [ventana("W24H", HOY, [{ valores: { energy_kcal: 2400 } }], objetivos)],
      }),
    );
    expect(r.adjustments).toEqual([]);
    // La ventana del día SÍ puede quedar como la ventana del veredicto —es la
    // única que hay—, pero jamás como la que sostiene un ajuste. Y el desvío
    // del día se DICE, no se calla: sin esta afirmación el caso se confundía
    // con "no pasó nada".
    expect(r.window).toBe("W24H");
    expect(r.reasons.map((x) => x.code)).toContain("SINGLE_DAY_DEVIATION");

    // La otra mitad, la que NO es verdadera por vacuidad: con D3 en la entrada
    // sí hay ajuste, y aun así la ventana que lo sostiene no es la del día.
    const conD3 = reviewAdaptiveNutrition(
      entrada({
        resolvedTargets: objetivos,
        dailyTargets: objetivos,
        balances: balancesD3(
          [{ valores: { energy_kcal: 2400 } }, { valores: { energy_kcal: 2400 } }, { valores: { energy_kcal: 2400 } }],
          objetivos,
        ),
      }),
    );
    expect(conD3.adjustments.length, "sin ajustes la afirmación de abajo es vacía").toBeGreaterThan(0);
    expect(conD3.adjustments.every((a) => a.window !== "W24H")).toBe(true);
  });

  it("con menos días medidos que el mínimo, el veredicto tope es NO_CHANGE", () => {
    const objetivos: TargetSet = { ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 } };
    const dias: DiaSpec[] = [
      { sinRegistro: true, mealsExpected: 0 },
      { valores: { energy_kcal: 2400 } },
      { valores: { energy_kcal: 2400 } },
    ];
    const r = reviewAdaptiveNutrition(
      entrada({ resolvedTargets: objetivos, dailyTargets: objetivos, balances: balancesD3(dias, objetivos) }),
    );
    expect(r.adjustments).toEqual([]);
    expect(r.reasons.map((x) => x.code)).toContain("HISTORY_TOO_SHORT");
  });

  it("un desvío dentro de la banda de ruido no mueve nada", () => {
    const objetivos: TargetSet = { ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 } };
    const dias: DiaSpec[] = [
      { valores: { energy_kcal: 2040 } },
      { valores: { energy_kcal: 2040 } },
      { valores: { energy_kcal: 2040 } },
    ];
    const r = reviewAdaptiveNutrition(
      entrada({ resolvedTargets: objetivos, dailyTargets: objetivos, balances: balancesD3(dias, objetivos) }),
    );
    expect(r.verdict).toBe("NO_CHANGE");
    expect(r.reasons.map((x) => x.code)).toContain("WITHIN_NOISE_BAND");
  });
});

describe("seguimiento básico: la energía no se toca", () => {
  it("con BASIC no se propone ningún ajuste de ENERGY_KCAL", () => {
    const r = reviewAdaptiveNutrition(deficitInput({ trackingMode: "BASIC" }));
    expect(r.adjustments.filter((a) => a.goalType === "ENERGY_KCAL")).toEqual([]);
    expect(r.reasons.map((x) => x.code)).toContain("TRACKING_MODE_BASIC");
  });

  it("y los demás objetivos sí se pueden seguir proponiendo", () => {
    const objetivos: TargetSet = {
      ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 },
      PROTEIN_G: { minimum: 90, preferred: 100, maximum: 130 },
    };
    const dias: DiaSpec[] = [
      { valores: { energy_kcal: 1600, protein_g: 120 } },
      { valores: { energy_kcal: 1600, protein_g: 120 } },
      { valores: { energy_kcal: 1600, protein_g: 120 } },
    ];
    const r = reviewAdaptiveNutrition(
      entrada({
        trackingMode: "BASIC",
        resolvedTargets: objetivos,
        dailyTargets: objetivos,
        balances: balancesD3(dias, objetivos),
      }),
    );
    expect(r.adjustments.map((a) => a.goalType)).toEqual(["PROTEIN_G"]);
  });
});

// ---------------------------------------------------------------------------
// DETERMINISMO
// ---------------------------------------------------------------------------

describe("determinismo byte a byte", () => {
  const escenarios: Record<string, AdaptiveInput> = {
    superavit: entrada(),
    deficit: deficitInput(),
    conTecho: deficitInput({ clinicalCeilings: [techo("energy_kcal", 2100)] }),
    bloqueado: deficitInput({ clinicalCeilings: [techo("energy_kcal", 1500)] }),
    sinContexto: deficitInput({ clinicalContextResolved: false }),
  };

  it("la misma entrada produce el mismo JSON, byte a byte", () => {
    for (const [nombre, input] of Object.entries(escenarios)) {
      const a = JSON.stringify(reviewAdaptiveNutrition(input));
      const b = JSON.stringify(reviewAdaptiveNutrition(input));
      expect(a, `${nombre} no es determinista`).toBe(b);
      expect(a.length).toBeGreaterThan(10);
    }
  });

  it("el orden en que llegan los techos clínicos no cambia la salida", () => {
    const techos = [
      techo("energy_kcal", 2100, { restrictionId: "r-a" }),
      techo("energy_kcal", 2050, { restrictionId: "r-b" }),
      techo("protein_g", 120, { restrictionId: "r-c" }),
    ];
    const directo = JSON.stringify(reviewAdaptiveNutrition(deficitInput({ clinicalCeilings: techos })));
    const alReves = JSON.stringify(
      reviewAdaptiveNutrition(deficitInput({ clinicalCeilings: [...techos].reverse() })),
    );
    expect(directo).toBe(alReves);
  });

  /**
   * TAMBIÉN EN ROJO A PROPÓSITO, y también por un defecto de `engine.ts` que
   * este agente no puede editar.
   *
   * `unverifiedCeilings` (engine.ts:535) se ordena con una clave que NO es
   * total: sólo `restrictionId`. Dos cotas que comparten restricción y difieren
   * en nutriente —sodio y potasio, justo el par que nombra el comentario de
   * arriba— empatan, y el empate lo resuelve el orden de llegada del arreglo de
   * entrada. Permutar la entrada cambia la salida byte a byte, y
   * `unverifiedCeilings` es superficie médica que se PERSISTE en
   * `adaptive_review_clinical_context`.
   *
   * ARREGLO: clave compuesta `${restrictionId}|${nutrient}`, igual que hacen
   * los otros dos ordenamientos del mismo archivo (`restrictionId|kind` en
   * clinicalOverrides:862 —al que le falta el nutriente por la misma razón— y
   * `kind|target|detail` en ordenarMissing:444).
   */
  it("dos techos con el MISMO id y distinto nutriente salen siempre en el mismo orden", () => {
    const cotas: ClinicalCeiling[] = [
      techo("sodium_mg", 2000, { restrictionId: "r-uno" }),
      techo("potassium_mg", 3000, { restrictionId: "r-uno" }),
    ];
    const directo = JSON.stringify(
      reviewAdaptiveNutrition(deficitInput({ clinicalCeilings: cotas })).unverifiedCeilings,
    );
    const alReves = JSON.stringify(
      reviewAdaptiveNutrition(deficitInput({ clinicalCeilings: [...cotas].reverse() })).unverifiedCeilings,
    );
    expect(directo.length, "sin techos sin GoalType este test no mira nada").toBeGreaterThan(10);
    expect(
      alReves,
      "permutar la ENTRADA cambió la salida: el desempate de unverifiedCeilings (engine.ts:535) " +
        "sólo mira restrictionId. ARREGLO: ordenar por `${restrictionId}|${nutrient}`.",
    ).toBe(directo);
  });

  it("no hay reloj: la fecha entra por INPUT y nada más", () => {
    for (const archivo of ["engine.ts", "types.ts"]) {
      expect(/new Date\(\)|Date\.now\(\)/.test(fuente(archivo)), `${archivo} usa reloj propio`).toBe(false);
    }
  });

  it("no hay `?? 0`, `|| 0` ni `|| []` en el motor: lo que no se sabe se declara null", () => {
    for (const archivo of ["engine.ts", "types.ts"]) {
      const src = fuente(archivo);
      expect(/\?\?\s*0(?![.\d])|\|\|\s*0(?![.\d])/.test(src), `${archivo} convierte desconocido en 0`).toBe(false);
      expect(/\?\?\s*\[\]|\|\|\s*\[\]/.test(src), `${archivo} convierte desconocido en lista vacía`).toBe(false);
      expect(/catch\s*\([^)]*\)\s*\{\s*\}/.test(src), `${archivo} tiene un catch vacío`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// LA ENTRADA SE VALIDA A GRITOS
// ---------------------------------------------------------------------------

describe("un cargador con un bug no se tapa acá adentro", () => {
  it("una fecha que no existe en el calendario revienta", () => {
    expect(() => reviewAdaptiveNutrition(entrada({ date: "2026-02-30" }))).toThrow(/calendario/);
  });

  it("una ventana que termina otro día revienta", () => {
    const objetivos: TargetSet = { ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 } };
    expect(() =>
      reviewAdaptiveNutrition(
        entrada({
          balances: [ventana("W24H", "2026-08-19", [{ valores: { energy_kcal: 2400 } }], objetivos)],
        }),
      ),
    ).toThrow(/días distintos/);
  });

  it("sin la ventana W24H revienta", () => {
    const objetivos: TargetSet = { ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 } };
    const dias: DiaSpec[] = [
      { valores: { energy_kcal: 2400 } },
      { valores: { energy_kcal: 2400 } },
      { valores: { energy_kcal: 2400 } },
    ];
    expect(() =>
      reviewAdaptiveNutrition(entrada({ balances: [ventana("D3", HOY, dias, objetivos)] })),
    ).toThrow(/W24H/);
  });

  it("la misma ventana dos veces revienta", () => {
    const objetivos: TargetSet = { ENERGY_KCAL: { minimum: 1600, preferred: 2000, maximum: 2200 } };
    const w = ventana("W24H", HOY, [{ valores: { energy_kcal: 2400 } }], objetivos);
    expect(() => reviewAdaptiveNutrition(entrada({ balances: [w, w] }))).toThrow(/dos veces/);
  });
});

// ---------------------------------------------------------------------------
// CONTRATO CON LA BASE Y CON LOS OTROS MOTORES
// ---------------------------------------------------------------------------

describe("los números y las unidades tienen UN dueño", () => {
  const migracion = readFileSync(
    path.join(RAIZ, "supabase/migrations/0040_adaptive_reviews.sql"),
    "utf8",
  );

  it("maxValidityDays vale lo mismo que public.adaptive_max_validity_days()", () => {
    const m = /adaptive_max_validity_days\(\)[\s\S]*?select\s+(\d+);/.exec(migracion);
    expect(m?.[1]).toBeDefined();
    expect(Number(m?.[1])).toBe(DEFAULT_ADAPTIVE_PARAMS.maxValidityDays);
  });

  it("los cinco veredictos son los mismos del enum public.adaptive_verdict", () => {
    const m = /create type public\.adaptive_verdict as enum\s*\(([\s\S]*?)\)/.exec(migracion);
    const enBase = (m?.[1] ?? "").match(/'([A-Z_]+)'/g)?.map((s) => s.replaceAll("'", "")) ?? [];
    expect(enBase.sort()).toEqual(
      ["INSUFFICIENT_DATA", "NO_CHANGE", "OPTIONAL_ADJUSTMENT", "RECOMMENDED_ADJUSTMENT", "REVIEW_REQUIRED"].sort(),
    );
  });

  it("la unidad canónica coincide con app.adaptive_nutrient_unit y con el motor clínico", () => {
    expect(unidadDeNutriente("energy_kcal")).toBe("kcal");
    expect(unidadDeNutriente("sodium_mg")).toBe("mg");
    expect(unidadDeNutriente("protein_g")).toBe("g");
    // La gemela SQL: mismas tres ramas.
    expect(migracion.includes("when p_key = 'energy_kcal' then 'kcal'")).toBe(true);
    expect(migracion.includes("when p_key like '%\\_mg'    then 'mg'")).toBe(true);
    // Y la gemela del motor clínico.
    const clinico = readFileSync(path.join(__dirname, "../../clinical/engine.ts"), "utf8");
    expect(clinico.includes('if (key === "energy_kcal") return "kcal";')).toBe(true);
    expect(clinico.includes('if (key.endsWith("_mg")) return "mg";')).toBe(true);
  });

  it("el scope del ajuste se traduce al enum goal_scope en un solo lugar", () => {
    expect(fuente("types.ts")).toContain('ADAPTIVE_ADJUSTMENT_GOAL_SCOPE = "DAILY"');
  });

  it("la configuración congelada lleva la versión y todos los topes", () => {
    const frozen = frozenAdaptiveConfig();
    expect(frozen.engine_version).toBe(ADAPTIVE_ENGINE_VERSION);
    expect(frozen.params.max_increase_ratio).toBe(1.1);
    expect(frozen.params.max_decrease_ratio).toBe(0.9);
    expect(frozen.params.max_validity_days).toBe(3);
    expect(reviewAdaptiveNutrition(deficitInput()).frozen).toEqual(frozen);
  });
});

// ---------------------------------------------------------------------------
// LO QUE LEE UNA PERSONA
// ---------------------------------------------------------------------------

describe("las razones las lee una persona", () => {
  it("ningún texto lleva juicio de valor, gamificación ni voseo", () => {
    const prohibidas =
      /\bracha\b|\bstreak\b|quemar|compensa|te pasaste|\bayuno\b|penaliza|puntaje|\bscore\b|meta cumplida|felicit|te falt[oó]|deber[íi]as|\bmal\b|\bbien hecho\b/i;
    const voseo = /\b(ten[ée]s|pod[ée]s|quer[ée]s|deb[ée]s|sos|and[áa])\b/;
    const vistos: string[] = [];
    const escenarios = [
      entrada(),
      deficitInput(),
      deficitInput({ clinicalCeilings: [techo("energy_kcal", 2100)] }),
      deficitInput({ clinicalCeilings: [techo("energy_kcal", 1500)] }),
      deficitInput({ pendingClinicalReviews: 1 }),
      deficitInput({ trackingMode: "OFF" }),
      deficitInput({ trackingMode: "BASIC" }),
      deficitInput({ clinicalContextResolved: false }),
    ];
    for (const input of escenarios) {
      for (const razon of reviewAdaptiveNutrition(input).reasons) {
        vistos.push(razon.text);
        expect(razon.text.length, `${razon.code} sin texto`).toBeGreaterThan(10);
        expect(prohibidas.test(razon.text), `${razon.code}: "${razon.text}"`).toBe(false);
        expect(voseo.test(razon.text), `${razon.code} usa voseo: "${razon.text}"`).toBe(false);
        expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(razon.text), "hay un emoji").toBe(false);
      }
    }
    expect(vistos.length).toBeGreaterThan(8);
  });

  it("ningún veredicto sale sin razón", () => {
    for (const input of [entrada(), deficitInput(), deficitInput({ trackingMode: "OFF" })]) {
      expect(reviewAdaptiveNutrition(input).reasons.length).toBeGreaterThan(0);
    }
  });

  it("el guardián de léxico también cubre el código fuente del motor", () => {
    const prohibidas = /\bracha\b|\bstreak\b|puntaje|\bscore\b|te pasaste/i;
    for (const archivo of ["engine.ts", "types.ts"]) {
      expect(prohibidas.test(fuente(archivo)), `${archivo} habla de rachas o puntajes`).toBe(false);
    }
  });
});
