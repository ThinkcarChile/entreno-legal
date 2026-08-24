import type { NutritionValues, BasisUnit, WeightBasis } from "./types";

/**
 * Abstracciones de proveedores externos (ADR 0001 §6).
 * La UI y el dominio dependen SOLO de estas interfaces; una implementación
 * USDA FoodData Central u Open Food Facts se agrega sin tocar componentes.
 * En este sprint no existe implementación productiva.
 */

export interface ExternalFoodSummary {
  providerId: string;
  externalId: string;
  name: string;
  brand?: string;
}

export interface ExternalFoodDetail extends ExternalFoodSummary {
  raw: unknown; // payload original del proveedor, conservado para trazabilidad
}

export interface MappedNutrition {
  per100: NutritionValues;
  basisUnit: BasisUnit;
  weightBasis: WeightBasis;
  sourceName: string;
  sourceRecordId: string;
  sourceVersion?: string;
}

/** Proveedor de datos de alimentos (p. ej. USDA FoodData Central). */
export interface FoodDataProvider {
  readonly id: string;
  search(query: string, limit?: number): Promise<ExternalFoodSummary[]>;
  getFood(externalId: string): Promise<ExternalFoodDetail | null>;
  mapNutrition(detail: ExternalFoodDetail): MappedNutrition;
}

/** Proveedor de productos por código de barras (p. ej. Open Food Facts, ODbL). */
export interface BarcodeProductProvider {
  readonly id: string;
  lookupBarcode(barcode: string): Promise<ExternalFoodDetail | null>;
}
