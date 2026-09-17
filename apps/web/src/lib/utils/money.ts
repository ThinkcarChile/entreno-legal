/**
 * Dinero.
 *
 * Regla del proyecto: todos los montos son enteros en la unidad mínima de la moneda.
 * Para CLP la unidad mínima es el peso (cero decimales). Nunca usar `number` flotante
 * para aritmética monetaria ni `numeric` en la base.
 */

export type CurrencyCode = "CLP" | "USD" | "EUR" | "PEN" | "ARS" | "COP" | "MXN";

export interface Money {
  /** Entero en unidad mínima. Para CLP, pesos. */
  readonly amount: number;
  readonly currency: CurrencyCode;
}

/** Decimales de la unidad mínima por moneda. */
const MINOR_UNIT_DIGITS: Record<CurrencyCode, number> = {
  CLP: 0,
  USD: 2,
  EUR: 2,
  PEN: 2,
  ARS: 2,
  COP: 0,
  MXN: 2,
};

export function money(amount: number, currency: CurrencyCode = "CLP"): Money {
  if (!Number.isInteger(amount)) {
    throw new TypeError(
      `Los montos deben ser enteros en unidad mínima. Recibido: ${amount} ${currency}`,
    );
  }
  return { amount, currency };
}

export function zero(currency: CurrencyCode = "CLP"): Money {
  return { amount: 0, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`No se pueden operar monedas distintas: ${a.currency} y ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function multiply(a: Money, factor: number): Money {
  return { amount: Math.round(a.amount * factor), currency: a.currency };
}

/** Aplica una tasa en puntos base (1500 = 15%). Redondeo a la unidad mínima. */
export function applyBps(a: Money, bps: number): Money {
  return { amount: Math.round((a.amount * bps) / 10_000), currency: a.currency };
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amount - b.amount;
}

export function isZero(a: Money): boolean {
  return a.amount === 0;
}

/** Monto por hora aplicado a una duración en minutos, redondeado al entero más cercano. */
export function proratePerHour(hourlyRate: Money, minutes: number): Money {
  return {
    amount: Math.round((hourlyRate.amount * minutes) / 60),
    currency: hourlyRate.currency,
  };
}

export function formatMoney(
  value: Money,
  options: { locale?: string; withCurrencySymbol?: boolean } = {},
): string {
  const { locale = "es-CL", withCurrencySymbol = true } = options;
  const digits = MINOR_UNIT_DIGITS[value.currency];
  const numeric = value.amount / 10 ** digits;

  return new Intl.NumberFormat(locale, {
    style: withCurrencySymbol ? "currency" : "decimal",
    currency: value.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(numeric);
}

/** "$8.000–$10.000" para rangos sugeridos. */
export function formatMoneyRange(min: Money, max: Money, locale = "es-CL"): string {
  if (min.amount === max.amount) return formatMoney(min, { locale });
  return `${formatMoney(min, { locale })}–${formatMoney(max, { locale })}`;
}

export function formatHourlyRate(value: Money, locale = "es-CL"): string {
  return `${formatMoney(value, { locale })}/h`;
}

/** Redondea al múltiplo indicado. Los precios sugeridos en CLP se muestran redondeados. */
export function roundToNearest(value: Money, step: number): Money {
  if (step <= 0) return value;
  return { amount: Math.round(value.amount / step) * step, currency: value.currency };
}
