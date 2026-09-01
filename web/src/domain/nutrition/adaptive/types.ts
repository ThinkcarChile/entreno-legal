import type { NutrientKey } from "@/domain/catalog/types";
import type { ClinicalAssessmentStatus, ClinicalSeverity } from "@/domain/clinical/types";
import type { EventEffect } from "@/domain/nutrition/events";
import type { GoalRange, GoalType, TargetSet, TrackingMode } from "@/domain/nutrition/types";

import type { Confidence, DataCoverage, RollingBalance, RollingWindow } from "./rolling";

/**
 * CONTRATO DEL MOTOR ADAPTATIVO — "¿el objetivo que esta persona declaró se
 * parece a lo que de verdad come, y conviene moverlo un poco por unos días?".
 *
 * Tres límites que este archivo hace IMPOSIBLES por construcción del tipo, no
 * por buena voluntad del código:
 *
 *  · No se puede proponer saltarse una comida. `AdaptiveAdjustment` solo lleva
 *    un `GoalRange` sobre un `GoalType`; desactivar una comida vive en
 *    `member_daily_plan_meals.enabled` y ese campo no existe acá.
 *  · No se puede proponer "quemar lo comido". No hay actividad, ni gasto
 *    energético, ni ejercicio en ninguna entrada ni en ninguna salida.
 *  · No se puede proponer un cambio permanente. `scope` tiene UN solo valor y
 *    `validUntil` no es opcional: un ajuste sin término es un cambio de
 *    objetivo, y ese camino pasa por `nutrition_goals` con decisión humana.
 */
export const ADAPTIVE_ENGINE_VERSION = "adaptive-nutrition/1.0.0";

/**
 * El `scope` del ajuste traducido al enum `public.goal_scope` de la base
 * (0005:24). Los nombres NO coinciden a propósito: acá el tipo dice
 * "TEMPORARY_DAY" para que un ajuste por comida ni siquiera se pueda escribir,
 * y la base guarda 'DAILY'. La traducción vive en UN solo lugar para que quien
 * serialice hacia `create_adaptive_review` no la vuelva a escribir a mano.
 */
export const ADAPTIVE_ADJUSTMENT_GOAL_SCOPE = "DAILY";

// ---------------------------------------------------------------------------
// Parámetros: configuración VERSIONADA, no constantes enterradas
// ---------------------------------------------------------------------------

/** Topes DUROS. Se congelan con cada revisión: cambiarlos mañana no reescribe el ayer. */
export interface AdaptiveParams {
  /** Cuánto puede ensanchar un ajuste, sobre el objetivo del día. */
  maxIncreaseRatio: number;
  /** Cuánto puede apretar. Un déficit agresivo NO es una propuesta válida. */
  maxDecreaseRatio: number;
  /** Ningún ajuste baja del mínimo declarado. */
  minimumFloorPolicy: "NEVER_BELOW_DECLARED_MINIMUM";
  /** El motor jamás propone saltarse una comida ni ayunar. */
  fastingPolicy: "NEVER_PROPOSE_FASTING";
  /** El motor jamás propone "quemar lo comido": no toca gasto ni ejercicio. */
  compensationPolicy: "NEVER_COMPENSATE_INTAKE_WITH_ACTIVITY";
  /**
   * Días máximos de vigencia de un ajuste temporal. Tiene que valer lo mismo
   * que `public.adaptive_max_validity_days()` (0040): cuando hay dos topes
   * manda el más laxo, y el más laxo estaba en la base. Hay un test que compara
   * este número contra el de la migración.
   */
  maxValidityDays: number;
  /** Cobertura mínima para pasar de OPTIONAL a RECOMMENDED. */
  minCoverageForRecommendation: number;
  /** Desvío relativo bajo el cual no se propone nada: ruido, no señal. */
  noiseBandRatio: number;
  /** Cobertura mínima para siquiera opinar. Bajo esto: INSUFFICIENT_DATA. */
  minCoverageForAnyVerdict: number;
  /**
   * Días CERRADOS y medidos que hacen falta para que exista cualquier ajuste.
   *
   * Sin este número, un solo día atípico —un asado, una gastroenteritis, un
   * viaje— llegaba a la bandeja con un botón de aplicar. La ventana de 24 horas
   * sirve para EXPLICAR el día; jamás para sostener un cambio de objetivo.
   */
  minClosedDaysForAnyAdjustment: number;
  /**
   * Bajo esta fracción del objetivo, un consumo sostenido deja de ser un
   * problema de calibración de metas: es una señal que sube a una persona SIN
   * ajuste asociado. Varios días de "no comí" no son varios días de meta mal
   * puesta, y tratarlos igual sería convertir un patrón de subconsumo en una
   * recomendación.
   */
  underEatingRatio: number;
  /** Cuántos días medidos hacen falta para afirmar ese patrón. */
  underEatingMinDays: number;
  windows: readonly RollingWindow[];
}

export const DEFAULT_ADAPTIVE_PARAMS: AdaptiveParams = {
  maxIncreaseRatio: 1.1, // +10%
  maxDecreaseRatio: 0.9, // −10%, el mismo tope que aroundTargetMultiplier de event-strategy/1.0.0
  minimumFloorPolicy: "NEVER_BELOW_DECLARED_MINIMUM",
  fastingPolicy: "NEVER_PROPOSE_FASTING",
  compensationPolicy: "NEVER_COMPENSATE_INTAKE_WITH_ACTIVITY",
  maxValidityDays: 3,
  minCoverageForRecommendation: 0.8,
  noiseBandRatio: 0.05,
  minCoverageForAnyVerdict: 0.5,
  minClosedDaysForAnyAdjustment: 3,
  underEatingRatio: 0.5,
  underEatingMinDays: 2,
  windows: ["W24H", "D3", "D7"],
};

/** Se congela en `adaptive_nutrition_reviews.params`, igual que `frozenEffectConfig()`. */
export interface FrozenAdaptiveConfig {
  engine_version: string;
  params: {
    max_increase_ratio: number;
    max_decrease_ratio: number;
    minimum_floor_policy: string;
    fasting_policy: string;
    compensation_policy: string;
    max_validity_days: number;
    min_coverage_for_recommendation: number;
    noise_band_ratio: number;
    min_coverage_for_any_verdict: number;
    min_closed_days_for_any_adjustment: number;
    under_eating_ratio: number;
    under_eating_min_days: number;
    windows: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Veredicto y razones
// ---------------------------------------------------------------------------

/**
 * Los mismos cinco valores del enum `public.adaptive_verdict` (0040).
 * INSUFFICIENT_DATA no es NO_CHANGE: "no me alcanzan los datos para opinar" no
 * es "miré y está bien". UNKNOWN nunca significa NORMAL.
 */
export type AdaptiveVerdict =
  | "INSUFFICIENT_DATA"
  | "NO_CHANGE"
  | "OPTIONAL_ADJUSTMENT"
  | "RECOMMENDED_ADJUSTMENT"
  | "REVIEW_REQUIRED";

/** Códigos PROPIOS. No se amplía `ClinicalReason['code']`: lo clínico se cita, no se mezcla. */
export type AdaptiveReasonCode =
  // — datos —
  | "DATA_COVERAGE_INSUFFICIENT"
  | "NUTRIENT_UNKNOWN"
  | "NUTRIENT_PARTIAL"
  | "LOWER_BOUND_CANNOT_SUSTAIN_DEFICIT"
  | "NO_TARGET_DECLARED"
  /**
   * Hubo comida medida y hubo objetivo, pero NO SOBRE LOS MISMOS DÍAS, así que
   * la resta compararía dos universos distintos y fabricaría un desvío que
   * nadie vivió. `rollingBalance` ya lo declara dejando `delta` en null; este
   * código es cómo llega esa nada hasta la superficie.
   *
   * Nació de un ataque: sin él, el motor tomaba el null de "no pude comparar"
   * por el null de "no hay señal" y salía con NO_CHANGE diciendo «quedó dentro
   * del rango que declaraste» — una afirmación POSITIVA sobre una comparación
   * que nunca se hizo, y con `missingData` vacío. La persona había comido 50 %
   * sobre su objetivo seis días seguidos.
   */
  | "NO_COMPARABLE_TARGET_DAYS"
  | "TRACKING_MODE_OFF"
  | "TRACKING_MODE_BASIC"
  | "HISTORY_TOO_SHORT"
  | "DAY_UNTRACKED_BY_EVENT"
  // — veredicto —
  | "WITHIN_NOISE_BAND"
  | "SUSTAINED_SURPLUS"
  | "SUSTAINED_DEFICIT"
  | "SUSTAINED_UNDEREATING"
  | "SINGLE_DAY_DEVIATION"
  // — topes duros —
  | "ADJUSTMENT_CAPPED_BY_PARAMS"
  | "FLOOR_MINIMUM_ENFORCED"
  | "NO_FASTING_ALLOWED"
  | "NO_ACTIVITY_COMPENSATION"
  | "EVENT_EFFECT_RESPECTED"
  | "NO_CEILING_INVENTED"
  // — clínico —
  | "CLINICAL_CEILING_APPLIED"
  | "CLINICAL_CEILING_BLOCKS_PROPOSAL"
  | "CLINICAL_FLOOR_BLOCKS_PROPOSAL"
  | "CLINICAL_LIMIT_UNUSABLE"
  | "CLINICAL_CEILING_UNVERIFIED"
  | "CLINICAL_REVIEW_PENDING"
  | "CLINICAL_STATUS_BLOCKS_PROPOSAL"
  | "CLINICAL_STATUS_UNKNOWN"
  | "CLINICAL_CONTEXT_UNRESOLVED";

/**
 * Los códigos que NUNCA pueden nombrar un nutriente ni una cifra.
 *
 * `AdaptiveReview.reasons` se guarda en `adaptive_nutrition_reviews`, que es la
 * superficie del HOGAR: la ve cualquier integrante, sin permiso médico. Decir
 * ahí "tu objetivo de potasio quedó acotado" es publicar la condición aunque no
 * se nombre ninguna enfermedad. El detalle vive en
 * `adaptive_review_clinical_context`, bajo `app.medical_access`.
 */
export const REASON_CODES_SIN_NUTRIENTE: readonly AdaptiveReasonCode[] = [
  "CLINICAL_CEILING_APPLIED",
  "CLINICAL_CEILING_BLOCKS_PROPOSAL",
  "CLINICAL_FLOOR_BLOCKS_PROPOSAL",
  "CLINICAL_LIMIT_UNUSABLE",
  "CLINICAL_CEILING_UNVERIFIED",
  "CLINICAL_REVIEW_PENDING",
  "CLINICAL_STATUS_BLOCKS_PROPOSAL",
  "CLINICAL_STATUS_UNKNOWN",
  "CLINICAL_CONTEXT_UNRESOLVED",
];

export interface AdaptiveReason {
  code: AdaptiveReasonCode;
  /** `null` obligatorio para los códigos clínicos: ver REASON_CODES_SIN_NUTRIENTE. */
  nutrient: NutrientKey | null;
  /** Español chileno neutro, tuteo. Sin lenguaje diagnóstico ni juicios de valor. */
  text: string;
  params: Record<string, string | number | null>;
}

// ---------------------------------------------------------------------------
// El canal clínico: cota, no sugerencia
// ---------------------------------------------------------------------------

/**
 * Techo clínico vigente. `max: number | null` a propósito:
 * `member_clinical_restrictions.value` es NULLABLE (0027:245) y una restricción
 * CONFIRMED sin cifra significa "hay un límite y no sabemos cuál" — jamás "no
 * hay límite". Una cota así BLOQUEA el ajuste sobre su nutriente; la cota no se
 * descarta nunca.
 *
 * `unit` viaja siempre. Un techo de "2 g de sodio" compuesto con `Math.min`
 * contra un objetivo en mg deja 2 mg de sodio: el límite se respeta negándose a
 * convertir, igual que hace `clinical/engine.ts`.
 */
export interface ClinicalCeiling {
  nutrient: NutrientKey;
  max: number | null;
  unit: string | null;
  restrictionId: string;
  severity: ClinicalSeverity;
}

/**
 * Piso clínico vigente (`NUTRIENT_MIN`). El canal es SIMÉTRICO al de los techos
 * porque `minimumFloorPolicy` protege el mínimo que declaró la PERSONA, que no
 * es el mínimo que indicó un profesional: sin esto, un superávit sostenido
 * podía apretar la proteína bajo un mínimo clínico confirmado y ninguna capa lo
 * notaba.
 */
export interface ClinicalFloor {
  nutrient: NutrientKey;
  min: number | null;
  unit: string | null;
  restrictionId: string;
  severity: ClinicalSeverity;
}

/** Por qué una cota clínica no se puede aplicar. Mismos códigos que `app.adaptive_clinical_context`. */
export type ClinicalLimitUnusableWhy = "LIMIT_WITHOUT_VALUE" | "UNIT_MISMATCH";

export interface ClinicalLimitUnusable {
  nutrient: NutrientKey;
  restrictionId: string;
  why: ClinicalLimitUnusableWhy;
  unit: string | null;
  expectedUnit: string;
}

/**
 * Qué recortó una cota clínica. NUNCA se copia a `reasons` ni a la superficie
 * del hogar: lleva `restrictionId`, nutriente y cifra, o sea la condición
 * entera con disfraz aritmético.
 */
export interface ClinicalOverride {
  restrictionId: string;
  nutrient: NutrientKey;
  kind: "CEILING" | "FLOOR";
  cappedAt: number;
}

/**
 * Techo clínico sobre un nutriente que NINGÚN objetivo puede expresar (sodio,
 * potasio, fósforo). Subir +10% la energía sube el sodio, pero como no existe
 * un `GoalType` con esa clave, la composición no encuentra nada que recortar y
 * el resultado sale con `clinicalOverrides: []`. Ese arreglo vacío se lee como
 * "lo clínico no tuvo nada que decir" cuando la verdad es "no se verificó", y
 * esa diferencia es exactamente lo que este campo declara.
 */
export interface UnverifiedCeiling {
  restrictionId: string;
  nutrient: NutrientKey;
  reason: "NO_GOAL_TYPE_FOR_NUTRIENT";
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export interface AdaptiveInput {
  /** Día civil del hogar, 'YYYY-MM-DD'. El motor NO tiene reloj. */
  date: string;
  memberId: string;
  trackingMode: TrackingMode;
  /** Objetivo PERMANENTE vigente. Solo se lee; jamás se propone tocarlo. */
  dailyTargets: TargetSet;
  /** Objetivos efectivos del día: patrón + override + evento + ajuste temporal vigente. */
  resolvedTargets: TargetSet;
  eventEffect: EventEffect;
  /** Una por ventana. Debe incluir 'W24H', y todas terminan en `date`. */
  balances: readonly RollingBalance[];

  /**
   * OBLIGATORIO, y existe por la peor falla posible de este motor: todas las
   * lecturas del proyecto pasan por la sesión del usuario, y
   * `member_clinical_restrictions` exige `VIEW_CLINICAL_RESTRICTIONS`
   * (0027:266). Quien no tenga ese permiso recibe CERO filas por RLS, y un
   * arreglo vacío se leería como "no hay techos": el "lo clínico siempre gana"
   * se apagaría solo, en silencio, justo para el caller que menos derecho tiene.
   *
   * Lo pone `app.adaptive_clinical_context` (SECURITY DEFINER), que devuelve
   * `resolved: true` cuando de verdad pudo mirar. En `false`, el motor se calla.
   */
  clinicalContextResolved: boolean;
  clinicalCeilings: readonly ClinicalCeiling[];
  clinicalFloors: readonly ClinicalFloor[];
  /** Cotas que la base ya marcó inservibles. El motor además reclasifica las que recibe. */
  clinicalUnusableLimits: readonly ClinicalLimitUnusable[];
  /** Veredicto clínico más grave vigente ese día. `null` = no evaluada, que NO es "compatible". */
  clinicalStatus: ClinicalAssessmentStatus | null;
  /** `clinical_impact_reviews` en PENDING. `null` = no se pudo contar, que no es cero. */
  pendingClinicalReviews: number | null;
  /**
   * Restricciones CONFIRMED vigentes, de cualquier tipo. `null` = no se pudo
   * contar. Con restricciones vigentes y sin veredicto del día, "no evaluada"
   * se estaba tratando como "compatible": la misma familia de UNKNOWN→NORMAL
   * que el ADR 0012 prohíbe, en la única capa nueva que puede mover objetivos.
   */
  activeClinicalRestrictions: number | null;

  params?: AdaptiveParams;
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export interface AdaptiveAdjustment {
  goalType: GoalType;
  nutrient: NutrientKey;
  /** Por construcción del tipo: un ajuste adaptativo SIEMPRE es temporal y de día entero. */
  scope: "TEMPORARY_DAY";
  /** >= input.date. Nunca retroactivo. */
  validFrom: string;
  /** Nunca sin término, y nunca más allá de `params.maxValidityDays`. */
  validUntil: string;
  from: GoalRange;
  to: GoalRange;
  reasonCode: AdaptiveReasonCode;
  /** Qué recortó la propuesta antes de salir. Vacío = salió tal cual se calculó. */
  cappedBy: readonly ("PARAMS" | "MINIMUM_FLOOR" | "CLINICAL_CEILING" | "CLINICAL_FLOOR")[];
  /** La ventana que sostiene ESTE ajuste. Nunca 'W24H': un día no cambia un objetivo. */
  window: RollingWindow;
}

export interface AdaptiveMissingData {
  kind: "NUTRIENT" | "MEAL" | "DAY" | "TARGET";
  target: string;
  detail: string;
}

export interface AdaptiveReview {
  engineVersion: string;
  verdict: AdaptiveVerdict;
  /** La ventana que sostiene el veredicto. null cuando no se apoya en ninguna. */
  window: RollingWindow | null;
  /** Vacío salvo en OPTIONAL_ADJUSTMENT y RECOMMENDED_ADJUSTMENT. */
  adjustments: readonly AdaptiveAdjustment[];
  /** Nunca vacío: ningún veredicto sale sin razón explícita. */
  reasons: readonly AdaptiveReason[];
  /** Qué faltó para poder opinar. Sin una sola palabra clínica: ver REASON_CODES_SIN_NUTRIENTE. */
  missingData: readonly AdaptiveMissingData[];
  /** SUPERFICIE MÉDICA. Va a `adaptive_review_clinical_context`, jamás a la del hogar. */
  clinicalOverrides: readonly ClinicalOverride[];
  /** SUPERFICIE MÉDICA. Techos que no se pudieron verificar por falta de GoalType. */
  unverifiedCeilings: readonly UnverifiedCeiling[];
  coverage: DataCoverage;
  confidence: Confidence;
  frozen: FrozenAdaptiveConfig;
}

export function frozenAdaptiveConfig(
  params: AdaptiveParams = DEFAULT_ADAPTIVE_PARAMS,
): FrozenAdaptiveConfig {
  return {
    engine_version: ADAPTIVE_ENGINE_VERSION,
    params: {
      max_increase_ratio: params.maxIncreaseRatio,
      max_decrease_ratio: params.maxDecreaseRatio,
      minimum_floor_policy: params.minimumFloorPolicy,
      fasting_policy: params.fastingPolicy,
      compensation_policy: params.compensationPolicy,
      max_validity_days: params.maxValidityDays,
      min_coverage_for_recommendation: params.minCoverageForRecommendation,
      noise_band_ratio: params.noiseBandRatio,
      min_coverage_for_any_verdict: params.minCoverageForAnyVerdict,
      min_closed_days_for_any_adjustment: params.minClosedDaysForAnyAdjustment,
      under_eating_ratio: params.underEatingRatio,
      under_eating_min_days: params.underEatingMinDays,
      windows: [...params.windows],
    },
  };
}
