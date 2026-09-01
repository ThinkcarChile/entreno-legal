import {
  NUTRIENT_KEYS,
  type AggregatedNutrition,
  type NutrientCompleteness,
  type NutrientKey,
} from "@/domain/catalog/types";
import { addDays } from "@/domain/nutrition/calendar";
import { GOAL_TYPES, type GoalType, type TargetSet, type TrackingMode } from "@/domain/nutrition/types";

/**
 * MOTOR DE BALANCE MÓVIL — "cuánto comió de verdad esta persona contra lo que
 * se propuso, en los últimos N días".
 *
 * Es PURO: sin reloj, sin red, sin IA, sin base de datos. La fecha entra por
 * `endDate` porque el día civil es del HOGAR (`app.household_today`), no del
 * servidor ni del navegador: declarar a las 00:30 la cena de anoche no puede
 * cambiarla de día, y un motor que leyera el reloj del proceso haría
 * exactamente eso.
 */
export const ROLLING_BALANCE_VERSION = "rolling-balance/1.0.0";

export type RollingWindow = "W24H" | "D3" | "D7";

export const ROLLING_WINDOW_DAYS: Readonly<Record<RollingWindow, number>> = {
  W24H: 1,
  D3: 3,
  D7: 7,
};

// ---------------------------------------------------------------------------
// GoalType <-> NutrientKey
// ---------------------------------------------------------------------------

/**
 * El puente entre "lo que la persona se propuso" (GoalType) y "lo que el
 * cálculo nutricional produce" (NutrientKey).
 *
 * Vive acá y no enterrado en el optimizador porque hasta hoy el mapeo existía
 * solo como literales sueltos repartidos por `optimizer.ts` ("protein_g" al
 * lado de PROTEIN_G, y así). Dos lugares escribiendo el mismo mapeo a mano es
 * cómo nace una traducción que se desincroniza: CARBOHYDRATE_G es SINGULAR y su
 * nutriente es `carbohydrates_g`, PLURAL. Ese detalle ya es una trampa; que
 * viva una sola vez es la única defensa real.
 */
const GOAL_TYPE_TO_NUTRIENT_KEY: Readonly<Record<GoalType, NutrientKey>> = {
  ENERGY_KCAL: "energy_kcal",
  PROTEIN_G: "protein_g",
  CARBOHYDRATE_G: "carbohydrates_g",
  FAT_G: "fat_g",
  FIBER_G: "fiber_g",
};

export function goalTypeToNutrientKey(goalType: GoalType): NutrientKey {
  return GOAL_TYPE_TO_NUTRIENT_KEY[goalType];
}

const NUTRIENT_KEY_TO_GOAL_TYPE: Readonly<Partial<Record<NutrientKey, GoalType>>> = (() => {
  const mapa: Partial<Record<NutrientKey, GoalType>> = {};
  for (const goalType of GOAL_TYPES) mapa[GOAL_TYPE_TO_NUTRIENT_KEY[goalType]] = goalType;
  return mapa;
})();

/**
 * La vuelta del mapeo. Devuelve `null` —no un GoalType inventado— para los
 * nutrientes que NINGÚN objetivo puede expresar hoy (sodio, potasio, fósforo,
 * azúcares, grasa saturada). Esos cinco existen en el cálculo y en los techos
 * clínicos, pero nadie se los puede fijar como meta: decir "no hay objetivo" es
 * la respuesta honesta, y es distinta de decir "el objetivo es cero".
 */
export function nutrientKeyToGoalType(key: NutrientKey): GoalType | null {
  const goalType = NUTRIENT_KEY_TO_GOAL_TYPE[key];
  return goalType === undefined ? null : goalType;
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/** Un día civil del hogar, con sus tres ejes SIEMPRE separados. */
export interface DayIntake {
  /** 'YYYY-MM-DD', día civil del hogar. */
  date: string;
  /** Suma de las porciones planificadas de ese día. */
  planned: AggregatedNutrition | null;
  /** Suma de lo servido. null = nadie registró servido ese día. */
  served: AggregatedNutrition | null;
  /** Suma de las declaraciones de consumo VIVAS. null = día sin ningún registro real. */
  actual: AggregatedNutrition | null;
  /** Comidas ENABLED del patrón para ese día. 0 = patrón sin comidas. */
  mealsExpected: number;
  mealsServed: number;
  /** Comidas del PATRÓN con registro. Los snacks sueltos NO van acá. */
  mealsLogged: number;
  /**
   * Registros reales sin comida asignada (`meal_type is null`): el snack fuera
   * de casa. Van aparte de `mealsLogged` porque `count(distinct meal_type)`
   * ignora los NULL: tres snacks sueltos contaban como CERO comidas y hundían
   * la cobertura de alguien que registró todo lo que comió.
   */
  unassignedLogs: number;
  /** Ítems registrados con cantidad desconocida (`quantity is null`). */
  unknownQuantityItems: number;
  trackingMode: TrackingMode;
  /** El evento del día pidió SKIP_TRACKING: ese día no se mide. */
  skipTracking: boolean;
  /**
   * El día civil del hogar YA TERMINÓ (`date < app.household_today`).
   *
   * Sin este campo, "la cena no la registró" y "la cena todavía no ocurre" son
   * indistinguibles: a las 14:00, con desayuno y almuerzo anotados, la cena
   * pendiente se leía como déficit y el motor proponía subir la meta por el
   * simple hecho de que el día no había terminado. Un día en curso no entra en
   * ningún denominador.
   */
  isClosed: boolean;
}

export interface RollingBalanceInput {
  window: RollingWindow;
  /** Último día de la ventana, inclusive. La fecha entra por INPUT: el motor no tiene reloj. */
  endDate: string;
  /** Días ya filtrados y ordenados por fecha ascendente. Puede faltar alguno: se detecta y se reporta. */
  days: readonly DayIntake[];
  /** Objetivos efectivos por día (patrón + override + evento + ajuste temporal vigente). */
  targetsByDate: Readonly<Record<string, TargetSet>>;
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export type CoverageKind = "NONE" | "SPARSE" | "PARTIAL" | "FULL";

export type MissingReason = "NO_LOG" | "PARTIAL_LOG" | "NOT_IN_HISTORY";

export interface MissingDay {
  date: string;
  /**
   * Cuántas comidas del patrón quedaron sin registro.
   * `null` con NOT_IN_HISTORY: de un día que no existe en la historia no se
   * sabe cuántas comidas esperaba, y "no sé" no se escribe con un 0.
   */
  mealsMissing: number | null;
  reason: MissingReason;
}

export interface DataCoverage {
  kind: CoverageKind;
  daysExpected: number;
  /** Días de la ventana con al menos un registro real (comida del patrón o snack suelto). */
  daysWithAnyLog: number;
  /** Días de la ventana que no existen en la historia (persona nueva). */
  daysMissingFromHistory: number;
  /** Días presentes que todavía no terminaron. No son días sin registro: son días sin terminar. */
  daysInProgress: number;
  mealsExpected: number;
  mealsLogged: number;
  /** Registros reales sin comida asignada. Se informan, NUNCA inflan ni deflactan `mealRatio`. */
  unassignedLogs: number;
  /** Ítems con cantidad desconocida en la ventana. Un solo "no sé" ya impide la confianza máxima. */
  unknownQuantityItems: number;
  /** mealsLogged / mealsExpected. null si mealsExpected === 0: no se divide por cero ni se asume 1. */
  mealRatio: number | null;
  /** Días que no se miden a propósito (tracking OFF o SKIP_TRACKING). */
  daysUntracked: number;
  /** Qué faltó, día por día. Explícito, jamás silencioso. */
  missing: readonly MissingDay[];
}

export type ConfidenceLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export type RollingReasonCode =
  | "COVERAGE_FULL"
  | "COVERAGE_PARTIAL"
  | "COVERAGE_SPARSE"
  | "COVERAGE_NONE"
  | "NUTRIENT_UNKNOWN"
  | "NUTRIENT_PARTIAL"
  | "NUTRIENT_LOWER_BOUND"
  | "TARGET_DAYS_MISMATCH"
  | "UNKNOWN_QUANTITIES_PRESENT"
  | "TRACKING_OFF"
  | "TRACKING_BASIC_NO_ENERGY"
  | "DAY_UNTRACKED"
  | "DAY_IN_PROGRESS"
  | "SHORT_HISTORY";

export interface Confidence {
  level: ConfidenceLevel;
  reasons: readonly RollingReasonCode[];
}

export interface NutrientBalance {
  nutrient: NutrientKey;
  /** Lo REALMENTE comido en la ventana. null = desconocido, jamás 0. */
  actual: number | null;
  /**
   * Suma de los objetivos `preferred` de los días que ADEMÁS aportaron un valor
   * conocido de este nutriente. El universo de `target` nunca es más ancho que
   * el de `actual`: sumar 7 días de meta contra 3 días de comida fabrica un
   * déficit del 57% que nadie vivió.
   */
  target: number | null;
  /**
   * actual − target. null si cualquiera de los dos es null, y null también
   * cuando los dos números no salen del MISMO conjunto de días
   * (daysCounted !== daysComparable). Nunca se rellena.
   */
  delta: number | null;
  /** delta / target. null si target es null o 0. */
  deltaRatio: number | null;
  /** Completitud combinada de los días de la ventana que se miden. */
  completeness: NutrientCompleteness;
  /**
   * La suma es una COTA INFERIOR: hay aportes que no se conocían y lo que falta
   * solo puede SUMAR. Sostiene la conclusión "te pasaste"; jamás la conclusión
   * "te faltó" (§27).
   */
  isLowerBound: boolean;
  /** Días de la ventana que aportaron un valor conocido de este nutriente. */
  daysCounted: number;
  /** Días medibles de la ventana con objetivo declarado para este nutriente. */
  daysWithTarget: number;
  /** Días que aportaron valor conocido Y tenían objetivo: el único universo comparable. */
  daysComparable: number;
  /** Confianza de ESTE nutriente. La combinada es el peor de los que participan. */
  confidence: Confidence;
}

export interface RollingBalance {
  engineVersion: string;
  window: RollingWindow;
  /** Ambos DATE-only, comparables lexicográficamente. */
  startDate: string;
  endDate: string;
  balances: Readonly<Record<NutrientKey, NutrientBalance>>;
  coverage: DataCoverage;
  confidence: Confidence;
}

// ---------------------------------------------------------------------------
// Aritmética de fechas civiles, sin reloj
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valida forma Y calendario, y devuelve la MISMA cadena para poder seguir
 * comparando lexicográficamente.
 *
 * `addDays` normaliza en silencio: "2026-02-30" sale como "2026-03-02". Ese
 * corrimiento mudo movería de día una ventana entera, así que el ida y vuelta
 * es la prueba: si la fecha no vuelve idéntica, no existe en el calendario.
 * La aritmética se delega a `nutrition/calendar` a propósito — sumar días tiene
 * un solo dueño en este proyecto y este motor no abre un segundo.
 */
function assertDateOnly(value: string, campo: string): string {
  if (!DATE_RE.test(value)) {
    throw new RangeError(`${campo} debe ser una fecha 'YYYY-MM-DD', llegó "${value}"`);
  }
  if (addDays(value, 0) !== value) {
    throw new RangeError(`${campo} no es una fecha del calendario: "${value}"`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Confianza
// ---------------------------------------------------------------------------

const NIVEL_ORDEN: Readonly<Record<ConfidenceLevel, number>> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

/**
 * La confianza SOLO se compone con el peor de los dos. Misma forma que los
 * techos clínicos: es matemáticamente imposible que un nutriente bien medido
 * levante la confianza de uno que no se sabe.
 */
function peor(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  return NIVEL_ORDEN[a] <= NIVEL_ORDEN[b] ? a : b;
}

const COVERAGE_REASON: Readonly<Record<CoverageKind, RollingReasonCode>> = {
  FULL: "COVERAGE_FULL",
  PARTIAL: "COVERAGE_PARTIAL",
  SPARSE: "COVERAGE_SPARSE",
  NONE: "COVERAGE_NONE",
};

const COVERAGE_CONFIDENCE: Readonly<Record<CoverageKind, ConfidenceLevel>> = {
  FULL: "HIGH",
  PARTIAL: "MEDIUM",
  SPARSE: "LOW",
  NONE: "NONE",
};

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------

/**
 * Un día se MIDE cuando terminó y cuando alguien pidió medirlo. Los tres
 * motivos de exclusión son distintos entre sí y se cuentan por separado:
 * tracking apagado, evento con SKIP_TRACKING, y día todavía en curso.
 */
function esMedible(day: DayIntake): boolean {
  return day.isClosed && !day.skipTracking && day.trackingMode !== "OFF";
}

/** Lee el valor de un nutriente respetando la completitud declarada del vector. */
function valorConocido(
  agregado: AggregatedNutrition,
  key: NutrientKey,
  fecha: string,
): number | null {
  const estado = agregado.completeness[key];
  const bruto = agregado.values[key];
  if (estado === undefined) {
    throw new RangeError(
      `El día ${fecha} no declara completitud de ${key}: un vector sin completitud no es un dato`,
    );
  }
  if (estado === "UNKNOWN") return null;
  if (bruto === null || bruto === undefined) {
    // Contradicción del cargador: dice COMPLETE/PARTIAL y no trae número. Es un
    // ERROR, y un error no se degrada a vacío en silencio.
    throw new RangeError(
      `El día ${fecha} declara ${key} como ${estado} pero no trae valor: completitud y valor se contradicen`,
    );
  }
  return bruto;
}

function objetivoPreferido(targets: TargetSet | undefined, key: NutrientKey): number | null {
  if (targets === undefined) return null;
  const goalType = nutrientKeyToGoalType(key);
  if (goalType === null) return null;
  const rango = targets[goalType];
  if (rango === undefined) return null;
  return rango.preferred;
}

export function rollingBalance(input: RollingBalanceInput): RollingBalance {
  const largo = ROLLING_WINDOW_DAYS[input.window];
  if (largo === undefined) {
    throw new RangeError(`Ventana desconocida: "${String(input.window)}"`);
  }

  const endDate = assertDateOnly(input.endDate, "endDate");
  const startDate = addDays(endDate, -(largo - 1));

  // --- Validación de la entrada: los huecos se reportan, los errores se gritan ---
  // Las fechas son DATE-only, así que se comparan como texto: no hay husos ni
  // horas que puedan mover un límite.
  const porFecha = new Map<string, DayIntake>();
  let anterior = "";
  for (const day of input.days) {
    const fecha = assertDateOnly(day.date, "days[].date");
    if (fecha <= anterior) {
      throw new RangeError(
        `days debe venir ordenado por fecha ascendente y sin repetir: "${day.date}"`,
      );
    }
    anterior = fecha;
    if (fecha < startDate || fecha > endDate) {
      throw new RangeError(
        `El día "${day.date}" no pertenece a la ventana ${startDate}..${endDate}: filtrarlo es tarea del cargador`,
      );
    }
    porFecha.set(fecha, day);
  }

  // --- Recorrido de la ventana, día por día ---
  const medibles: DayIntake[] = [];
  const missing: MissingDay[] = [];
  let daysMissingFromHistory = 0;
  let daysInProgress = 0;
  let daysUntracked = 0;
  let daysWithAnyLog = 0;
  let mealsExpected = 0;
  let mealsLogged = 0;
  let unassignedLogs = 0;
  let unknownQuantityItems = 0;
  let hayTrackingOff = false;
  let hayBasic = false;

  for (let i = 0; i < largo; i += 1) {
    const fecha = addDays(startDate, i);
    const day = porFecha.get(fecha);
    if (day === undefined) {
      // Persona nueva: el día no existe en la historia. NO es lo mismo que un
      // día sin registro, y de él no se sabe ni cuántas comidas esperaba.
      daysMissingFromHistory += 1;
      missing.push({ date: fecha, mealsMissing: null, reason: "NOT_IN_HISTORY" });
      continue;
    }

    if (day.trackingMode === "OFF") hayTrackingOff = true;
    if (day.trackingMode === "BASIC") hayBasic = true;
    if (day.trackingMode === "OFF" || day.skipTracking) daysUntracked += 1;
    if (!day.isClosed) daysInProgress += 1;
    if (day.mealsLogged > 0 || day.unassignedLogs > 0 || day.actual !== null) daysWithAnyLog += 1;

    if (!esMedible(day)) continue;

    medibles.push(day);
    mealsExpected += day.mealsExpected;
    mealsLogged += day.mealsLogged;
    unassignedLogs += day.unassignedLogs;
    unknownQuantityItems += day.unknownQuantityItems;

    const faltan = day.mealsExpected - day.mealsLogged;
    if (faltan > 0) {
      missing.push({
        date: fecha,
        mealsMissing: faltan,
        reason: day.mealsLogged === 0 ? "NO_LOG" : "PARTIAL_LOG",
      });
    }
  }

  missing.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // mealRatio: null cuando no hay comidas esperadas. Ni 1 ni 0 — no se divide
  // por cero, y "el patrón no espera nada" no es "registró todo".
  const mealRatio = mealsExpected === 0 ? null : mealsLogged / mealsExpected;

  let kind: CoverageKind;
  if (mealRatio === null || mealRatio === 0) {
    kind = "NONE";
  } else if (daysMissingFromHistory === 0 && missing.length === 0 && mealRatio >= 1) {
    kind = "FULL";
  } else if (mealRatio >= 0.6) {
    kind = "PARTIAL";
  } else {
    kind = "SPARSE";
  }

  const coverage: DataCoverage = {
    kind,
    daysExpected: largo,
    daysWithAnyLog,
    daysMissingFromHistory,
    daysInProgress,
    mealsExpected,
    mealsLogged,
    unassignedLogs,
    unknownQuantityItems,
    mealRatio,
    daysUntracked,
    missing,
  };

  // --- Razones de ventana: valen para todos los nutrientes ---
  const razonesVentana: RollingReasonCode[] = [COVERAGE_REASON[kind]];
  if (daysInProgress > 0) razonesVentana.push("DAY_IN_PROGRESS");
  if (daysMissingFromHistory > 0) razonesVentana.push("SHORT_HISTORY");
  if (hayTrackingOff) razonesVentana.push("TRACKING_OFF");
  if (daysUntracked > 0) razonesVentana.push("DAY_UNTRACKED");
  if (unknownQuantityItems > 0) razonesVentana.push("UNKNOWN_QUANTITIES_PRESENT");

  const nivelVentana = COVERAGE_CONFIDENCE[kind];
  /**
   * Techo de la ventana. Dos cosas lo bajan, y las dos por el mismo motivo: la
   * confianza máxima es una afirmación sobre TODA la ventana.
   *
   *  · Un solo "no sé" de cantidad. Uno basta.
   *  · Que la ventana no esté entera. Siete días con cuatro en SKIP_TRACKING y
   *    tres perfectos es cobertura completa DE LO MEDIBLE, pero sigue siendo un
   *    veredicto de siete días sostenido por tres: se informa como MEDIUM y el
   *    motor de arriba decide si le alcanza.
   */
  const techoVentana: ConfidenceLevel =
    unknownQuantityItems > 0 || medibles.length < largo ? "MEDIUM" : "HIGH";

  // --- Balance por nutriente ---
  const balances = {} as Record<NutrientKey, NutrientBalance>;
  const razonesCombinadas: RollingReasonCode[] = [...razonesVentana];
  let combinado: ConfidenceLevel | null = null;

  for (const key of NUTRIENT_KEYS) {
    let suma = 0;
    let sumaObjetivo = 0;
    let daysCounted = 0;
    let daysWithTarget = 0;
    let daysComparable = 0;

    for (const day of medibles) {
      const objetivo = objetivoPreferido(input.targetsByDate[day.date], key);
      if (objetivo !== null) daysWithTarget += 1;

      const valor = day.actual === null ? null : valorConocido(day.actual, key, day.date);
      if (valor === null) continue;

      suma += valor;
      daysCounted += 1;
      if (objetivo !== null) {
        sumaObjetivo += objetivo;
        daysComparable += 1;
      }
    }

    // Completitud combinada: un día que aporta y otro que no ⇒ PARTIAL. El día
    // medible SIN registro cuenta como desconocido, porque el hueco es real.
    let completeness: NutrientCompleteness;
    if (medibles.length === 0 || daysCounted === 0) completeness = "UNKNOWN";
    else if (daysCounted === medibles.length) completeness = "COMPLETE";
    else completeness = "PARTIAL";

    // Y aunque TODOS los días aporten, cada día puede traer su propia suma
    // parcial: eso también deja el total en cota inferior. Hay DOS formas de
    // que un día sea parcial, y durante un rato acá solo se miraba una.
    //
    //   (a) el vector del día declara PARTIAL el nutriente: la comida se
    //       registró pero a algún alimento le faltaba el dato.
    //
    //   (b) FALTARON COMIDAS POR REGISTRAR. Esta se descubrió con un ataque:
    //       tres días con tres comidas esperadas y dos registradas, 1.200 kcal
    //       cada uno, contra un objetivo de 2.000. El motor devolvía
    //       completeness COMPLETE, isLowerBound false y un déficit de 2.400 kcal
    //       (−40 %) — un déficit que nadie vivió, porque esa persona comió: no
    //       anotó. La cobertura SÍ lo sabía (mealRatio 0,67, tres días marcados
    //       PARTIAL_LOG), pero ese dato no llegaba hasta acá, y el número salía
    //       con cara de medición completa.
    //
    //       Es exactamente el vacío leído como cero, y aguas abajo se convierte
    //       en una propuesta de SUBIRLE los objetivos a alguien por no haber
    //       anotado el almuerzo.
    //
    // Las dos formas dan lo mismo: lo que falta solo puede SUMAR, así que el
    // total es un piso. Sostiene "te pasaste"; jamás "te faltó".
    if (completeness === "COMPLETE") {
      for (const day of medibles) {
        const vectorParcial = day.actual !== null && day.actual.completeness[key] === "PARTIAL";
        const comidasSinRegistrar = day.mealsExpected > 0 && day.mealsLogged < day.mealsExpected;
        if (vectorParcial || comidasSinRegistrar) {
          completeness = "PARTIAL";
          break;
        }
      }
    }

    const actual = daysCounted === 0 ? null : suma;
    const target = daysComparable === 0 ? null : sumaObjetivo;
    // Los dos números tienen que salir del MISMO conjunto de días. Si un día
    // aportó comida pero no tenía objetivo declarado, restar fabrica un delta
    // que nadie vivió: se declara null y se dice por qué.
    const universosCalzan = daysCounted > 0 && daysCounted === daysComparable;
    const delta = actual === null || target === null || !universosCalzan ? null : actual - target;
    const deltaRatio = delta === null || target === null || target === 0 ? null : delta / target;
    const isLowerBound = completeness === "PARTIAL";

    // --- Confianza del nutriente ---
    const razones: RollingReasonCode[] = [...razonesVentana];
    let nivel = peor(nivelVentana, techoVentana);

    if (completeness === "UNKNOWN" || daysCounted === 0) {
      nivel = "NONE";
      razones.push("NUTRIENT_UNKNOWN");
    } else if (completeness === "PARTIAL") {
      nivel = peor(nivel, "MEDIUM");
      razones.push("NUTRIENT_PARTIAL");
    }
    if (isLowerBound) razones.push("NUTRIENT_LOWER_BOUND");
    if (daysWithTarget > 0 && daysCounted !== daysComparable) {
      nivel = peor(nivel, "MEDIUM");
      razones.push("TARGET_DAYS_MISMATCH");
    }
    // BASIC significa "objetivos sin exigir registro detallado": la energía de
    // esos días es la menos confiable de todas, así que no puede llegar a HIGH.
    if (hayBasic && key === "energy_kcal") {
      nivel = peor(nivel, "MEDIUM");
      razones.push("TRACKING_BASIC_NO_ENERGY");
    }

    balances[key] = {
      nutrient: key,
      actual,
      target,
      delta,
      deltaRatio,
      completeness,
      isLowerBound,
      daysCounted,
      daysWithTarget,
      daysComparable,
      confidence: { level: nivel, reasons: razones },
    };

    // PARTICIPA el nutriente sobre el que alguien se fijó una meta. Los otros
    // cinco (sodio, potasio, fósforo, azúcares, grasa saturada) no tienen
    // objetivo posible y arrastrarían la confianza combinada a NONE para
    // siempre: no se puede castigar al motor por no medir lo que nadie pidió.
    if (daysWithTarget > 0) {
      combinado = combinado === null ? nivel : peor(combinado, nivel);
      for (const razon of razones) {
        if (!razonesCombinadas.includes(razon)) razonesCombinadas.push(razon);
      }
    }
  }

  // Sin ningún nutriente con objetivo declarado no hay nada que afirmar.
  const nivelCombinado: ConfidenceLevel = combinado === null ? "NONE" : combinado;

  return {
    engineVersion: ROLLING_BALANCE_VERSION,
    window: input.window,
    startDate,
    endDate,
    balances,
    coverage,
    confidence: { level: nivelCombinado, reasons: razonesCombinadas },
  };
}
