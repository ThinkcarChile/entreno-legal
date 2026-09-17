import { chileanHolidays2026, pricingRules, type PricingRules } from "@/config/pricing";
import { JobUrgency } from "@/lib/domain/enums";
import {
  formatDuration,
  formatInTimeZoneDateOnly,
  isWeekend,
  localHour,
  overnightFraction,
} from "./date-helpers";
import { formatMoneyRange, money, proratePerHour, roundToNearest } from "@/lib/utils/money";

import type { PriceSuggestion, PricingEngine, PricingFactor, PricingInput } from "./types";

/**
 * Motor v1: reglas declarativas y transparentes.
 *
 * Deliberadamente simple y explicable. Cuando exista volumen real se puede sustituir
 * por un motor basado en demanda sin cambiar la interfaz ni el esquema.
 */
export class RuleBasedPricingEngine implements PricingEngine {
  readonly name = "rule-based-v1";

  private readonly rules: PricingRules;

  // Sin "parameter properties": esa sintaxis no sobrevive al borrado de tipos de
  // Node, y este módulo debe poder ejecutarse fuera del bundler.
  constructor(rules: PricingRules = pricingRules) {
    this.rules = rules;
  }

  suggest(input: PricingInput): PriceSuggestion {
    // El rango de la categoría manda sobre el del grupo cuando existe.
    const base = input.categoryBase ?? this.rules.baseHourly[input.categoryGroup];
    const factors: PricingFactor[] = [];

    const hour = localHour(input.startsAt, input.timezone);

    // El recargo nocturno es proporcional al tiempo que realmente transcurre de
    // madrugada. Un turno completo de noche paga el recargo entero; una fila que
    // solo empieza temprano, la parte que le corresponde.
    const nightFraction = overnightFraction(
      input.startsAt,
      input.durationMinutes,
      input.timezone,
    );

    if (nightFraction > 0) {
      factors.push({
        code: "overnight",
        label: nightFraction >= 0.5 ? "Turno nocturno" : "Horas de madrugada",
        factor: 1 + (this.rules.multipliers.overnight - 1) * nightFraction,
      });
    } else if (hour >= 6 && hour < 8) {
      factors.push({
        code: "early_morning",
        label: "Inicio muy temprano",
        factor: this.rules.multipliers.earlyMorning,
      });
    }

    const dateOnly = formatInTimeZoneDateOnly(input.startsAt, input.timezone);
    if (chileanHolidays2026.includes(dateOnly)) {
      factors.push({ code: "holiday", label: "Día feriado", factor: this.rules.multipliers.holiday });
    } else if (isWeekend(input.startsAt, input.timezone)) {
      factors.push({ code: "weekend", label: "Fin de semana", factor: this.rules.multipliers.weekend });
    }

    if (input.urgency === JobUrgency.URGENTE) {
      factors.push({ code: "urgent", label: "Publicación urgente", factor: this.rules.multipliers.urgent });
    }

    const long = this.rules.multipliers.longJob;
    if (input.durationMinutes >= long.thresholdMinutes) {
      factors.push({
        code: "long_job",
        label: `Trabajo extenso (${formatDuration(input.durationMinutes)})`,
        factor: long.factor,
      });
    }

    const regionFactor = this.rules.regionFactors[input.regionCode] ?? 1;
    if (regionFactor !== 1) {
      factors.push({ code: "region", label: "Ajuste por región", factor: regionFactor });
    }

    const communeFactor = input.communeCode
      ? (this.rules.communeFactors[input.communeCode] ?? 1)
      : 1;
    if (communeFactor !== 1) {
      factors.push({ code: "commune", label: "Ajuste por comuna", factor: communeFactor });
    }

    const combined = factors.reduce((acc, f) => acc * f.factor, 1);

    const rawMin = Math.max(base.min * combined, this.rules.floorHourly);
    const rawMax = Math.max(base.max * combined, this.rules.floorHourly + this.rules.roundTo);

    const hourlyMin = roundToNearest(money(Math.round(rawMin)), this.rules.roundTo);
    const hourlyMax = roundToNearest(money(Math.round(rawMax)), this.rules.roundTo);
    const recommendedHourly = roundToNearest(
      money(Math.round((hourlyMin.amount + hourlyMax.amount) / 2)),
      this.rules.roundTo,
    );

    return {
      hourlyMin,
      hourlyMax,
      recommendedHourly,
      totalMin: proratePerHour(hourlyMin, input.durationMinutes),
      totalMax: proratePerHour(hourlyMax, input.durationMinutes),
      recommendedTotal: proratePerHour(recommendedHourly, input.durationMinutes),
      factors,
      explanation: buildExplanation(hourlyMin, hourlyMax, factors),
    };
  }
}

function buildExplanation(
  min: ReturnType<typeof money>,
  max: ReturnType<typeof money>,
  factors: readonly PricingFactor[],
): string {
  const range = formatMoneyRange(min, max);
  if (factors.length === 0) return `Precio sugerido para este trabajo: ${range} por hora.`;
  const reasons = factors.map((f) => f.label.toLowerCase()).join(", ");
  return `Precio sugerido para este trabajo: ${range} por hora. Considera ${reasons}.`;
}
