import type { CategoryGroup, JobUrgency } from "@/lib/domain/enums";
import type { Money } from "@/lib/utils/money";

export interface PricingInput {
  categoryGroup: CategoryGroup;
  categoryId?: string;
  /**
   * Rango base por hora de la categoría concreta, en unidad mínima.
   * Si se omite se usa el rango del grupo. Importa: "Madrugada y overnight"
   * tiene un piso más alto que el resto de las filas.
   */
  categoryBase?: { min: number; max: number };
  regionCode: string;
  communeCode?: string | null;
  /** Instante de inicio en UTC. */
  startsAt: string;
  durationMinutes: number;
  urgency: JobUrgency;
  timezone: string;
}

export interface PricingFactor {
  code: string;
  label: string;
  /** Multiplicador aplicado. 1.0 es neutro. */
  factor: number;
}

export interface PriceSuggestion {
  hourlyMin: Money;
  hourlyMax: Money;
  totalMin: Money;
  totalMax: Money;
  /** Valor recomendado por defecto dentro del rango. */
  recommendedHourly: Money;
  recommendedTotal: Money;
  /** Factores aplicados, para mostrarlos de forma transparente al cliente. */
  factors: readonly PricingFactor[];
  /** Texto corto listo para la interfaz. */
  explanation: string;
}

/**
 * Contrato del motor de precios.
 *
 * La plataforma sugiere; nunca fija el precio final. Cada trabajador decide su tarifa
 * al ofertar y el cliente elige.
 */
export interface PricingEngine {
  readonly name: string;
  suggest(input: PricingInput): PriceSuggestion;
}
