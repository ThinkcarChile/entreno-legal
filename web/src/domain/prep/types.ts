/**
 * Sprint 10 — Batch prep. Tipos de los motores:
 *   `storage-safety/1.0.0` — seguridad de conservación SOLO desde reglas
 *     validadas con fuente; sin regla → SAFETY_REVIEW_REQUIRED (§20-§21).
 *   `batch-prep/1.0.0` — qué conviene preparar AHORA y qué conviene no tocar
 *     (§2, §9), guiado por demanda confirmada, jamás inventando porciones.
 */

import type { StockUnit } from "@/domain/stock/types";

export type ProcessingState = "RAW" | "PREPPED" | "COOKED";
export type TemperatureState = "AMBIENT" | "CHILLED" | "FROZEN";
export type StorageKind = "PANTRY" | "FRIDGE" | "FREEZER" | "OTHER";

// ---------------------------------------------------------------------------
// Seguridad de conservación
// ---------------------------------------------------------------------------

export interface SafetyRule {
  id: string;
  /** true = regla del hogar (gana sobre la global). */
  isHousehold: boolean;
  ingredientId: string | null;
  categoryId: string | null;
  processingState: ProcessingState | null;
  temperatureState: TemperatureState | null;
  vacuumSealed: boolean | null;
  ruleKind: "STORAGE_DAYS" | "REFREEZE" | "THAW";
  /** STORAGE_DAYS: null = seguro sin fecha (regla EXPLÍCITA, no ausencia). */
  maxDays: number | null;
  useSoonWithinDays: number;
  refreezeAllowed: boolean | null;
  thawFridgeHours: number | null;
  /** La fuente validada es parte de la regla — sin fuente no hay regla. */
  source: string;
}

/** Los hechos del lote que la seguridad puede mirar. */
export interface LotFacts {
  ingredientId: string | null;
  categoryId: string | null;
  processingState: ProcessingState;
  temperatureState: TemperatureState;
  vacuumSealed: boolean;
  /** Día del hogar en que EMPEZÓ el estado de conservación actual. */
  storedSince: string;
}

export type SafetyVerdict =
  | { verdict: "SAFE"; safeUseBy: string | null; source: string; ruleId: string }
  | { verdict: "USE_SOON"; safeUseBy: string; source: string; ruleId: string }
  | { verdict: "DO_NOT_RECOMMEND"; safeUseBy: string; source: string; ruleId: string }
  | { verdict: "SAFETY_REVIEW_REQUIRED"; reason: string };

export type RefreezeVerdict =
  | { verdict: "ALLOWED"; source: string; ruleId: string }
  | { verdict: "DO_NOT_RECOMMEND"; source: string; ruleId: string }
  | { verdict: "SAFETY_REVIEW_REQUIRED"; reason: string };

export type ThawPlan =
  | { kind: "SCHEDULED"; moveDate: string; note: string; source: string }
  | { kind: "REVIEW"; reason: string };

// ---------------------------------------------------------------------------
// BatchPrepEngine
// ---------------------------------------------------------------------------

export interface PrepLot {
  id: string;
  ingredientId: string;
  categoryId: string | null;
  label: string;
  quantity: number;
  unit: StockUnit;
  processingState: ProcessingState;
  temperatureState: TemperatureState;
  vacuumSealed: boolean;
  locationKind: StorageKind | null;
  useBy: string | null;
  expiryDate: string | null;
  /** Día del hogar de creación (para FEFO cuando no hay fechas). */
  createdOn: string;
  intendedUseDate: string | null;
}

/** Demanda CONFIRMADA futura (porciones PLANNED) — jamás inventada (§8). */
export interface PrepDemand {
  assignmentId: string;
  date: string;
  mealType: string;
  ingredientId: string;
  quantity: number;
  unit: StockUnit;
}

export interface PrepPreference {
  ingredientId: string;
  taskType: "WASH" | "PEEL" | "TRIM" | "CUT" | "SHRED" | "SLICE" | "DICE" | "PORTION" | "PACK" | "VACUUM_SEAL" | "OTHER";
  params: Record<string, unknown>;
  capabilityId: string | null;
  manualAlternative: string | null;
}

export interface EquipmentConfig {
  id: string;
  equipmentId: string;
  equipmentName: string;
  equipmentActive: boolean;
  capability: string;
  params: Record<string, unknown>;
  maxBatchQuantity: number | null;
  /** Unidad de la capacidad por tanda: solo se compara si calza con el lote. */
  maxBatchUnit: "G" | "ML" | "UNIT" | null;
  isActive: boolean;
}

export interface PrepEngineInput {
  today: string;
  /** Cuántos días de demanda confirmada mirar (default 7). */
  horizonDays: number;
  lots: PrepLot[];
  demand: PrepDemand[];
  preferences: PrepPreference[];
  capabilities: EquipmentConfig[];
  safetyRules: SafetyRule[];
  /** §54: capacidad del congelador si se CONOCE; null = desconocida, sin tope. */
  freezerCapacityKnown: number | null;
}

/** Paquete sugerido dentro de una tarea PORTION (§8). */
export interface SuggestedPackage {
  quantity: number;
  intendedUseDate: string | null;
  intendedAssignmentId: string | null;
  mealType: string | null;
  /** Recomendación de guardado SOLO con regla validada (§23). */
  storage: "REFRIGERATE" | "FREEZE" | "REVIEW_REQUIRED";
  storageSource: string | null;
  reason: string;
}

export interface DraftTask {
  taskType:
    | "WASH" | "PEEL" | "TRIM" | "CUT" | "SHRED" | "SLICE" | "DICE"
    | "PORTION" | "PACK" | "VACUUM_SEAL" | "REFRIGERATE" | "FREEZE"
    | "THAW_LATER" | "LEAVE_WHOLE" | "LABEL" | "OTHER";
  blockLabel: string;
  lotId: string | null;
  ingredientId: string | null;
  label: string;
  plannedQuantity: number | null;
  unit: StockUnit | null;
  /** 1-based dentro del MISMO plan; el RPC lo resuelve a uuid. */
  dependsOnIndex: number | null;
  params: {
    capabilityId?: string | null;
    equipmentName?: string | null;
    cutLabel?: string | null;
    manualAlternative?: string | null;
    batches?: number;
    packages?: SuggestedPackage[];
    safety?: { verdict: string; source?: string | null };
    reasons?: string[];
  };
}

export interface ThawSuggestion {
  lotId: string;
  label: string;
  intendedUseDate: string;
  plan: ThawPlan;
}

export interface LeaveWholeNote {
  ingredientId: string;
  label: string;
  quantity: number;
  unit: StockUnit;
  reason: string;
}

export interface PrepPlanDraft {
  tasks: DraftTask[];
  leaveWhole: LeaveWholeNote[];
  thawSuggestions: ThawSuggestion[];
  /** Avisos del plan (§54: congelador conocido y sobrepasado, etc.). */
  warnings: string[];
  summary: {
    totalTasks: number;
    foods: number;
    packages: number;
    labels: number;
    estimatedMinutes: number;
  };
  /** §55: tareas + cambios de herramienta + cortes distintos + paquetes. */
  complexity: number;
  engineVersion: string;
}
