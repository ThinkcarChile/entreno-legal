import type { NutrientKey } from "@/domain/catalog/types";

/**
 * Tipos del dominio clínico (Sprint 11, ADR 0012).
 *
 * El motor SOLO ve datos confirmados: las capas de carga filtran
 * `verification_status = 'CONFIRMED'` antes de llegar acá. La IA no tiene
 * ninguna puerta a estos tipos.
 */

export const CLINICAL_ENGINE_VERSION = "clinical-rules/1.0.0";

export type ClinicalSeverity = "INFO" | "CAUTION" | "HARD" | "CRITICAL_REVIEW";

export type ClinicalRestrictionType =
  | "NUTRIENT_MAX"
  | "NUTRIENT_MIN"
  | "INGREDIENT_EXCLUDE"
  | "CATEGORY_EXCLUDE"
  | "PORTION_MAX"
  | "PORTION_MIN"
  | "MEAL_REQUIREMENT"
  | "REVIEW_REQUIRED"
  | "OTHER";

/**
 * Veredicto clínico de una comida para una persona.
 *
 * `NOT_ASSESSED` (0035) NO es un veredicto: es la ausencia de uno. Existe
 * porque antes esa ausencia se guardaba como NULL y NULL no pinta nada en
 * pantalla — o sea, se veía idéntica a una porción evaluada y limpia. El motor
 * jamás devuelve este valor: lo escribe la base al nacer la porción y lo
 * reemplaza quien la evalúa. UNKNOWN NUNCA SIGNIFICA NORMAL.
 */
export type ClinicalAssessmentStatus =
  | "COMPATIBLE"
  | "COMPATIBLE_WITH_CAUTION"
  | "REVIEW_REQUIRED"
  | "CLINICALLY_INVALIDATED"
  | "NOT_ASSESSED";

/** Los únicos dos que significan "alguien la miró Y salió limpia". */
export const ESTADOS_CLINICOS_LIMPIOS: readonly ClinicalAssessmentStatus[] = [
  "COMPATIBLE",
  "COMPATIBLE_WITH_CAUTION",
];

/**
 * Los que significan "alguien la miró". Todo lo demás —NOT_ASSESSED, NULL, o
 * una etiqueta nueva que este código todavía no conozca— es SIN EVALUAR. La
 * regla se escribe por complemento a propósito: una lista de estados
 * alarmantes deja pasar por limpio todo lo que no esté en ella, que es el
 * falso-seguro que costó esta migración.
 */
export const ESTADOS_CLINICOS_EVALUADOS: readonly ClinicalAssessmentStatus[] = [
  "COMPATIBLE",
  "COMPATIBLE_WITH_CAUTION",
  "REVIEW_REQUIRED",
  "CLINICALLY_INVALIDATED",
];

/** Restricción CONFIRMADA y vigente (el loader filtra; el motor re-verifica fechas). */
export interface ClinicalRestriction {
  id: string;
  type: ClinicalRestrictionType;
  /** NutrientKey para NUTRIENT_*, uuid de alimento/categoría para *_EXCLUDE y PORTION_*. */
  target: string;
  value: number | null;
  unit: string | null;
  severity: ClinicalSeverity;
  source: string;
  ruleVersionId: string | null;
  /** Biomarcadores que la regla vinculada exige vigentes (de required_inputs). */
  requiredBiomarkers: readonly { code: string; maxAgeDays: number | null }[];
  validFrom: string;   // DATE-only
  validUntil: string | null;
}

/** Observación CONFIRMADA (la única clase que entra al motor). */
export interface ConfirmedObservation {
  id: string;
  biomarkerCode: string;
  value: number;
  /** null = unidad DESCONOCIDA: el motor se niega a usarla donde importe. */
  unit: string | null;
  collectedDate: string | null; // DATE-only
}

/** Frecuencia configurada (jamás inventada) para calcular vigencia. */
export interface LabScheduleInput {
  biomarkerCode: string | null;
  intervalDays: number | null;
  source: string;
}

export type LabRecencyStatus =
  | "CURRENT"
  | "EXPIRING_SOON"
  | "OUTDATED"
  | "MISSING"
  | "NO_SCHEDULE_CONFIGURED";

export type NutrientCompletenessInput = Partial<
  Record<NutrientKey, "COMPLETE" | "PARTIAL" | "UNKNOWN">
>;

/**
 * De dónde salió la nutrición que se está evaluando (§1 del cierre v2).
 * NO se colapsan: la fuerza del veredicto depende de esto.
 *
 *  · CONFIRMED_MEMBER_SERVING — la porción que esta persona SIRVIÓ/COMIÓ.
 *  · PROJECTED_MEMBER_SERVING — la porción calculada para ella en esa comida.
 *  · RECIPE_BASE_ESTIMATE     — total de la receta ÷ porciones base. Es un
 *    SCREENING: no sabe cuánto le van a servir a esta persona.
 *  · NONE — no hay nutrición que evaluar.
 */
export type NutritionSource =
  | "CONFIRMED_MEMBER_SERVING"
  | "PROJECTED_MEMBER_SERVING"
  | "RECIPE_BASE_ESTIMATE"
  | "NONE";

/** Fuentes que hablan de la porción DE ESTA PERSONA. */
export const FUENTES_INDIVIDUALES: readonly NutritionSource[] = [
  "CONFIRMED_MEMBER_SERVING",
  "PROJECTED_MEMBER_SERVING",
];

export interface ClinicalAssessmentInput {
  /** Día civil del hogar. */
  date: string;
  /**
   * §1: sin esto el motor no puede saber si un "dentro del límite" habla de
   * la persona o de un promedio de la olla. Obligatorio.
   */
  nutritionSource: NutritionSource;
  restrictions: readonly ClinicalRestriction[];
  observations: readonly ConfirmedObservation[];
  schedules: readonly LabScheduleInput[];
  /** Nutrición de LA PORCIÓN (o de la receta si aún no hay porción). */
  nutrition: {
    values: Partial<Record<NutrientKey, number | null>>;
    completeness: NutrientCompletenessInput;
  };
  /** Identidades presentes en la receta/porción evaluada. */
  ingredientIds: readonly string[];
  categoryIds: readonly string[];
  /** Cantidad por alimento (para PORTION_MAX/MIN), en gramos de la porción. */
  quantitiesByIngredient: Readonly<Record<string, number>>;
}

export interface ClinicalReason {
  code:
    | "RESTRICTION_OK"
    | "NUTRIENT_OVER_MAX"
    | "NUTRIENT_UNDER_MIN"
    | "NUTRIENT_DATA_INCOMPLETE"
    | "UNIT_MISMATCH"
    | "INGREDIENT_EXCLUDED"
    | "CATEGORY_EXCLUDED"
    | "PORTION_OVER_MAX"
    | "PORTION_UNDER_MIN"
    | "REVIEW_RULE"
    | "SCREENING_ONLY"
    | "LAB_MISSING"
    | "LAB_UNIT_UNKNOWN"
    | "LAB_OUTDATED"
    | "CAUTION_NOTED";
  restrictionId: string;
  ruleVersionId: string | null;
  severity: ClinicalSeverity;
  text: string;
  params: Record<string, string | number | null>;
}

export interface ClinicalAssessment {
  engineVersion: string;
  status: ClinicalAssessmentStatus;
  /** §1: se persiste y se explica en pantalla. */
  nutritionSource: NutritionSource;
  reasons: ClinicalReason[];
  /** Qué faltó para poder verificar (§27-§29): explícito, jamás silencioso. */
  missingData: { kind: "NUTRIENT" | "BIOMARKER" | "UNIT"; target: string; detail: string }[];
  /** Restricciones violadas con certeza (datos completos). */
  violations: { restrictionId: string; severity: ClinicalSeverity; detail: string }[];
  /** Ajustes cuantitativos que el PortionOptimizer PUEDE intentar (§31). */
  proposedAdjustments: {
    kind: "NUTRIENT_CEILING";
    nutrient: NutrientKey;
    max: number;
    restrictionId: string;
  }[];
  /** Referencias usadas (§61): ids, no copias. */
  observationRefs: string[];
  ruleRefs: { restrictionId: string; ruleVersionId: string | null }[];
}
