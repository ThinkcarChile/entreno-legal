import type { WeightBasis } from "../catalog/types";

export type { WeightBasis };

/**
 * Stock Intelligence (Sprint 8) — tipos compartidos de los tres motores.
 *
 * Separación de responsabilidades (§1): PortionOptimizer decide porciones,
 * Planning decide comidas y personas, ShoppingEngine agrega demanda de compra,
 * InventoryEngine registra existencia física. Stock Intelligence ANALIZA y
 * RECOMIENDA — jamás compra, jamás toca el ledger, jamás cambia objetivos
 * nutricionales.
 */

export type StockUnit = "G" | "ML" | "UNIT";

/** Un lote usable, tal como sale del ledger. */
export interface StockLot {
  id: string;
  ingredientId: string;
  label: string;
  quantity: number;
  unit: StockUnit;
  weightBasis: WeightBasis;
  isApproximate: boolean;
  /** DATE-only o null. */
  expiryDate: string | null;
  useBy: string | null;
  createdAt: string;
  status: "AVAILABLE" | "RESERVED" | "CONSUMED" | "DISCARDED" | "SPLIT";
  acquisitionValue: number | null;
}

/** Demanda futura confirmada: un componente de una porción PLANNED con fecha. */
export interface FutureDemand {
  ingredientId: string;
  label: string;
  quantity: number;
  unit: StockUnit;
  weightBasis: WeightBasis;
  cookingMethod: string | null;
  /** DATE-only. */
  servingDate: string;
  projectionId: string;
}

/** Consumo DECLARADO (X, no Y): componentes de porciones CONSUMED por fecha. */
export interface ObservedConsumption {
  ingredientId: string;
  quantity: number;
  unit: StockUnit;
  weightBasis: WeightBasis;
  cookingMethod: string | null;
  /** DATE-only. */
  date: string;
}

/** Desajuste registrado: parte NO trazada del consumo declarado. */
export interface ShortfallStat {
  ingredientId: string;
  quantity: number;
  unit: StockUnit;
  /** Base física de la DEMANDA declarada (el shortfall vive en esa base). */
  weightBasis: WeightBasis;
  date: string | null;
}

/** Merma registrada en el ledger. */
export interface WasteStat {
  ingredientId: string;
  quantity: number;
  unit: StockUnit;
  weightBasis: WeightBasis;
  /** Proporción del valor del lote, cuando el lote tenía valor. */
  estimatedCost: number | null;
  date: string;
}

/** Compras recibidas (movimientos PURCHASE), para la señal de sobrecompra. */
export interface PurchaseStat {
  ingredientId: string;
  quantity: number;
  unit: StockUnit;
  weightBasis: WeightBasis;
  date: string;
}

export interface YieldEntry {
  ingredientId: string;
  cookingMethod: string | null;
  factor: number;
  /** true = curado por el hogar: le gana al global. */
  isHousehold: boolean;
}

export interface StockTarget {
  ingredientId: string;
  unit: StockUnit;
  minimumQuantity: number | null;
  targetQuantity: number | null;
  targetDaysOfSupply: number | null;
  safetyStock: number | null;
  reviewCycle: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "MIN_STOCK" | "CUSTOM" | null;
  reorderEnabled: boolean;
  source: "USER_DEFINED" | "SYSTEM_SUGGESTED";
}

export interface StockInput {
  /** Fecha efectiva del hogar, DATE-only. */
  today: string;
  lots: readonly StockLot[];
  futureDemand: readonly FutureDemand[];
  consumption: readonly ObservedConsumption[];
  shortfalls: readonly ShortfallStat[];
  waste: readonly WasteStat[];
  purchases: readonly PurchaseStat[];
  yields: readonly YieldEntry[];
  targets: readonly StockTarget[];
  /**
   * Hasta qué fecha (inclusive) la planificación confirmada cubre el
   * calendario del hogar (§2, §17): hasta ahí NO se agrega forecast
   * estadístico — la demanda confirmada GANA sobre el pronóstico.
   */
  planningCoveredUntil: string | null;
  ingredients: readonly { id: string; label: string; categoryCode: string | null }[];
}

// ---------------------------------------------------------------------------
// Salidas
// ---------------------------------------------------------------------------

export type ForecastConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface ConsumptionRate {
  /** Total declarado en la ventana (en la base cruda del alimento). */
  last7: number | null;
  last14: number | null;
  last30: number | null;
  /** Promedio diario elegido, con su ventana. null = INSUFFICIENT_DATA. */
  dailyRate: number | null;
  rateWindow: 7 | 14 | 30 | null;
  /** Días con historia válida (desde la primera observación, tope 30). */
  historyDays: number;
  observations: number;
  variability: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  /** Consumo trazado vs no trazado, para auditoría (§7). */
  tracedTotal30: number;
  untrackedTotal30: number;
}

export type CoverageStatus =
  | { kind: "DAYS"; days: number }
  | { kind: "INSUFFICIENT_DATA" }
  | { kind: "NO_EXPECTED_DEMAND" }
  | { kind: "UNRESOLVED"; reason: string };

export type ReorderStatus =
  | "NO_ACTION"
  | "WATCH"
  | "REORDER_SOON"
  | "REORDER_NOW"
  | "UNRESOLVED";

export interface ReorderRecommendation {
  status: ReorderStatus;
  /** Cantidad recomendada a comprar. Jamás negativa; null si no aplica. */
  recommendedQuantity: number | null;
  unit: StockUnit;
  /** Horizonte usado, en días. */
  horizonDays: number;
  reasons: string[];
  confidence: ForecastConfidence | null;
  engineVersion: string;
  forecastVersion: string;
}

export interface HorizonNeed {
  days: 7 | 14 | 30;
  confirmed: number;
  forecastUncovered: number;
  total: number;
}

export interface StockItem {
  ingredientId: string;
  label: string;
  categoryCode: string | null;
  unit: StockUnit;
  /**
   * Base física del bucket: los números de este item viven acá. RAW y DRAINED
   * son identidades separadas — el atún escurrido no se suma al crudo.
   */
  weightBasis: WeightBasis;

  onHand: number;
  hasApproximate: boolean;
  reserved: number;
  /** onHand − reserved. Puede ser negativo: ese negativo ES el faltante confirmado. */
  available: number;
  confirmedShortage: number;

  /** Demanda futura que NO pudo mapearse a este stock (base/unidad sin conversión). */
  unresolvedDemand: { quantity: number; unit: StockUnit; weightBasis: WeightBasis; reason: string }[];

  rate: ConsumptionRate;
  coverage: CoverageStatus;
  confidence: ForecastConfidence | null;
  confidenceReasons: string[];
  horizons: HorizonNeed[];
  reorder: ReorderRecommendation;
  target: StockTarget | null;

  /** Lote a usar primero (FEFO), si hay fecha válida que lo ordene. */
  useFirstLotId: string | null;
  useFirstLotLabel: string | null;

  waste30: number;
  wasteCost30: number | null;
  purchases30: number;
  /** "Históricamente compras por encima del consumo observado" (§25, §43). */
  overbuySignal: boolean;

  lots: StockLot[];
}
