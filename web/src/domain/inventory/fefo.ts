import type { WeightBasis } from "../catalog/types";

/**
 * FEFO y estado de vencimiento (Sprint 7).
 *
 * El orden de consumo es el del baseline (Addendum §12): `use_by` primero,
 * después `expiry_date`, después antigüedad. Las fechas son DATE-only
 * (`YYYY-MM-DD`) y se comparan como texto — jamás pasan por `Date` para no
 * correr el día.
 */

export type LotStatus = "AVAILABLE" | "RESERVED" | "CONSUMED" | "DISCARDED" | "SPLIT";

export interface PantryLot {
  id: string;
  ingredientId: string | null;
  productId: string | null;
  label: string;
  quantity: number;
  unit: "G" | "ML" | "UNIT";
  weightBasis: WeightBasis;
  processingState: "RAW" | "PREPPED" | "COOKED";
  temperatureState: "AMBIENT" | "CHILLED" | "FROZEN";
  locationId: string | null;
  /** DATE-only `YYYY-MM-DD` o null. */
  expiryDate: string | null;
  useBy: string | null;
  status: LotStatus;
  /** ISO timestamp de creación (solo para desempate FEFO). */
  createdAt: string;
}

/** Orden FEFO: use_by asc → expiry asc → más antiguo primero. NULL al final. */
export function fefoOrder<T extends Pick<PantryLot, "useBy" | "expiryDate" | "createdAt">>(
  lots: readonly T[],
): T[] {
  const clave = (a: string | null) => a ?? "9999-12-31";
  return [...lots].sort((a, b) => {
    const ua = clave(a.useBy);
    const ub = clave(b.useBy);
    if (ua !== ub) return ua < ub ? -1 : 1;
    const ea = clave(a.expiryDate);
    const eb = clave(b.expiryDate);
    if (ea !== eb) return ea < eb ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

export type ExpiryState = "EXPIRED" | "USE_TODAY" | "SOON" | "OK" | "NO_DATE";

export interface ExpiryInfo {
  state: ExpiryState;
  /** Días hasta la fecha relevante (negativo = ya pasó). null sin fecha. */
  days: number | null;
  /** Qué fecha mandó: use_by le gana a expiry. */
  basis: "USE_BY" | "EXPIRY" | null;
}

/** Días entre dos fechas DATE-only, sin husos horarios. */
function diasEntre(desde: string, hasta: string): number {
  const [y1, m1, d1] = desde.split("-").map(Number);
  const [y2, m2, d2] = hasta.split("-").map(Number);
  const a = Date.UTC(y1!, m1! - 1, d1!);
  const b = Date.UTC(y2!, m2! - 1, d2!);
  return Math.round((b - a) / 86_400_000);
}

/** Umbral de "pronto": 3 días, el aviso útil para planificar la semana. */
const DIAS_PRONTO = 3;

export function expiryInfo(
  lot: Pick<PantryLot, "expiryDate" | "useBy">,
  today: string,
): ExpiryInfo {
  const fecha = lot.useBy ?? lot.expiryDate;
  if (!fecha) return { state: "NO_DATE", days: null, basis: null };
  const basis = lot.useBy ? "USE_BY" : "EXPIRY";
  const days = diasEntre(today, fecha);
  if (days < 0) return { state: "EXPIRED", days, basis };
  if (days === 0) return { state: "USE_TODAY", days, basis };
  if (days <= DIAS_PRONTO) return { state: "SOON", days, basis };
  return { state: "OK", days, basis };
}

/**
 * Stock disponible agrupado por alimento, para el "descuento en compra": el
 * hint "tienes X en despensa" junto a cada línea de la lista.
 *
 * Solo lotes AVAILABLE y solo la MISMA representación (unidad + base de peso):
 * 300 g de arroz cocido no son 300 g de arroz crudo comprables, y esa mentira
 * ya está prohibida en el ShoppingEngine (§4).
 */
export function stockByIngredient(
  lots: readonly PantryLot[],
): Map<string, { quantity: number; lots: number }> {
  const stock = new Map<string, { quantity: number; lots: number }>();
  for (const lot of lots) {
    if (lot.status !== "AVAILABLE" || lot.quantity <= 0 || !lot.ingredientId) continue;
    const key = stockKey(lot.ingredientId, lot.unit, lot.weightBasis);
    const acc = stock.get(key) ?? { quantity: 0, lots: 0 };
    acc.quantity += lot.quantity;
    acc.lots += 1;
    stock.set(key, acc);
  }
  return stock;
}

export function stockKey(ingredientId: string, unit: string, weightBasis: string): string {
  return `${ingredientId}::${unit}::${weightBasis}`;
}
