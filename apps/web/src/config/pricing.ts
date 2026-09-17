import type { CategoryGroup } from "@/lib/domain/enums";

/**
 * Configuración declarativa del motor de precios sugeridos v1.
 *
 * Cambiar estos valores no requiere tocar código. Sustituir el algoritmo completo
 * tampoco: basta con otra implementación de `PricingEngine`.
 */

export interface PricingRules {
  /** Rango base por hora en CLP, antes de multiplicadores. */
  baseHourly: Record<CategoryGroup, { min: number; max: number }>;

  multipliers: {
    /** Recargo por tramo horario local de inicio. */
    overnight: number;
    earlyMorning: number;
    weekend: number;
    holiday: number;
    urgent: number;
    /** Descuento por trabajos largos: la hora marginal baja. */
    longJob: { thresholdMinutes: number; factor: number };
  };

  /** Ajuste por región. 1.0 es neutro. Refleja costo de vida y densidad de oferta. */
  regionFactors: Record<string, number>;

  /** Ajuste fino por comuna, encima del factor regional. */
  communeFactors: Record<string, number>;

  /** Piso absoluto por hora, en CLP. */
  floorHourly: number;

  /** Redondeo del valor sugerido, en CLP. */
  roundTo: number;
}

export const pricingRules: PricingRules = {
  baseHourly: {
    FILA: { min: 8_000, max: 10_000 },
    TRAMITE: { min: 9_000, max: 12_000 },
  },

  multipliers: {
    overnight: 1.45,
    earlyMorning: 1.25,
    weekend: 1.15,
    holiday: 1.3,
    urgent: 1.2,
    longJob: { thresholdMinutes: 480, factor: 0.92 },
  },

  regionFactors: {
    "13": 1.0,   // Metropolitana
    "05": 0.96,  // Valparaíso
    "08": 0.94,  // Biobío
    "02": 1.08,  // Antofagasta
    "12": 1.12,  // Magallanes
    "11": 1.1,   // Aysén
    "15": 1.02,  // Arica y Parinacota
    "01": 1.04,  // Tarapacá
  },

  communeFactors: {
    "13-las-condes": 1.08,
    "13-vitacura": 1.1,
    "13-lo-barnechea": 1.1,
    "13-providencia": 1.05,
    "13-santiago": 1.02,
    "05-isla-de-pascua": 1.25,
  },

  floorHourly: 6_000,
  roundTo: 500,
};

/** Feriados chilenos usados por el motor. Se mueve a base de datos en una etapa futura. */
export const chileanHolidays2026: readonly string[] = [
  "2026-01-01", "2026-04-03", "2026-04-04", "2026-05-01", "2026-05-21",
  "2026-06-21", "2026-06-29", "2026-07-16", "2026-08-15", "2026-09-18",
  "2026-09-19", "2026-10-12", "2026-10-31", "2026-11-01", "2026-12-08",
  "2026-12-25",
];
