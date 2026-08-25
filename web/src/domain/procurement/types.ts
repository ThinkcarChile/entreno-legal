/**
 * Sprint 9 — Procurement. Tipos del motor `purchase-schedule/1.0.0`.
 *
 * Separación de responsabilidades (§24):
 *   Stock Intelligence RECOMIENDA necesidad → este motor PLANIFICA el pedido
 *   (cuánto, cuándo, a quién) → Shopping lista → Inventory guarda lo físico →
 *   Receiving crea los lotes. Nada acá altera porciones ni nutrición.
 */

import type { ForecastConfidence, ReorderRecommendation, StockUnit } from "@/domain/stock/types";

/** Día ISO: 1 = lunes … 7 = domingo. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Supplier {
  id: string;
  name: string;
  isActive: boolean;
}

/** Una presentación concreta de un proveedor para un alimento. */
export interface SupplierProduct {
  id: string;
  supplierId: string;
  supplierName: string;
  supplierActive: boolean;
  ingredientId: string;
  presentation: string;
  /** Cantidad de UNA presentación, en unidad base. */
  packageQuantity: number;
  unit: StockUnit;
  price: number | null;
  minimumOrderQuantity: number | null;
  purchaseMultiple: number | null;
  leadTimeDays: number;
  /** null = entrega cualquier día. */
  deliveryDays: IsoWeekday[] | null;
  /** Menor = preferido. */
  priority: number;
  isActive: boolean;
}

/** Política de compra del hogar para un alimento (calendario + preferencia). */
export interface PurchasePolicy {
  ingredientId: string;
  preferredSupplierId: string | null;
  orderDays: IsoWeekday[] | null;
  receiveDays: IsoWeekday[] | null;
}

export type ProcurementStatus =
  | "SUGGESTED"
  | "PLANNED"
  | "ORDERED"
  | "READY"
  | "DELIVERING"
  | "RECEIVED"
  | "STORED"
  | "CANCELLED";

/** Estados donde la orden sigue VIVA y su mercadería viene en camino (§14). */
export const INCOMING_STATUSES: ProcurementStatus[] = ["PLANNED", "ORDERED", "READY", "DELIVERING"];

/** Un item de una orden existente, para netear la necesidad. */
export interface ExistingOrderItem {
  orderId: string;
  orderStatus: ProcurementStatus;
  ingredientId: string;
  quantity: number;
  unit: StockUnit;
  expectedDeliveryDate: string | null;
}

export interface PurchaseScheduleInput {
  /** Día del HOGAR (YYYY-MM-DD), jamás el del servidor. */
  today: string;
  /** Recomendaciones del ReorderEngine, por alimento (Sprint 8 manda acá). */
  needs: ProcurementNeed[];
  supplierProducts: SupplierProduct[];
  policies: PurchasePolicy[];
  /** Items de órdenes vivas: lo que ya viene en camino NO se vuelve a pedir. */
  existingItems: ExistingOrderItem[];
  /**
   * Capacidad de almacenamiento conocida por `ingredientId::unit`.
   * Ausente = DESCONOCIDA (jamás se inventa; sin tope). Valor = tope físico.
   */
  capacity: Record<string, number>;
}

/** Lo que Stock Intelligence entrega por alimento. */
export interface ProcurementNeed {
  ingredientId: string;
  label: string;
  unit: StockUnit;
  onHand: number;
  available: number;
  /** Días de cobertura actuales (null = sin dato / sin demanda esperada). */
  coverageDays: number | null;
  /** Consumo diario estimado (null = sin tasa). */
  dailyRate: number | null;
  reorder: ReorderRecommendation;
}

/** Por qué el motor decidió lo que decidió: cada paso con sus números (§23). */
export interface ProvenanceStep {
  step: string;
  detail: string;
}

export interface PurchaseSuggestion {
  ingredientId: string;
  label: string;
  unit: StockUnit;

  /** Necesidad NETA (recomendación − en camino). Jamás negativa. */
  requiredQuantity: number;
  /** Lo que conviene pedir tras mínimo/múltiplo/envase/capacidad (§17). */
  suggestedOrderQuantity: number;
  packageCount: number | null;

  supplierProductId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  presentation: string | null;
  /** Alternativas disponibles (v1: se listan, no se combinan — §18). */
  alternativeSuppliers: string[];

  orderDate: string | null;
  expectedDeliveryDate: string | null;

  /** En casa / en camino, SIEMPRE separados (§15): jamás se suman en uno. */
  onHand: number;
  incoming: number;

  /** Cobertura estimada tras recibir (null = sin tasa para estimarla). */
  coverageAfterDays: number | null;

  confidence: ForecastConfidence | null;
  provenance: ProvenanceStep[];
  warnings: string[];
  /** true = falta algo del hogar (proveedor, capacidad…): bloque "Necesita acción". */
  needsAction: boolean;

  engineVersion: string;
}

export interface PurchaseScheduleResult {
  suggestions: PurchaseSuggestion[];
  /** Alimentos cuya necesidad quedó COMPLETA con órdenes en camino (informativo). */
  coveredByIncoming: { ingredientId: string; label: string; incoming: number; unit: StockUnit }[];
  engineVersion: string;
}
