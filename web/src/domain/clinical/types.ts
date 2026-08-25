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

export type ClinicalAssessmentStatus =
  | "COMPATIBLE"
  | "COMPATIBLE_WITH_CAUTION"
  | "REVIEW_REQUIRED"
  | "CLINICALLY_INVALIDATED";

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

export interface ClinicalAssessmentInput {
  /** Día civil del hogar. */
  date: string;
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
