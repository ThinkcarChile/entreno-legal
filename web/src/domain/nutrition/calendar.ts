/**
 * Qué día es "hoy" para un hogar.
 *
 * A las 22:30 de un domingo en Santiago ya es lunes en UTC. Si la excepción del
 * día se resolviera en UTC, la comida del domingo por la noche se calcularía con
 * los objetivos del lunes — y nadie entendería por qué. La fecha efectiva sale
 * siempre de la zona horaria del hogar.
 */

export const DEFAULT_TIME_ZONE = "America/Santiago";

/** Fecha local del hogar en formato `YYYY-MM-DD`. */
export function effectiveDate(now: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA ya entrega YYYY-MM-DD; se arma por partes para no depender del formato.
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Suma días a una fecha `YYYY-MM-DD` sin pasar por husos horarios. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Texto humano de una fecha `YYYY-MM-DD`, sin desfase de un día. */
export function formatDate(date: string, locale = "es-CL"): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(locale, {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/**
 * Lunes de la semana a la que pertenece una fecha. En Chile la semana empieza
 * el lunes, y la semana se identifica siempre por ese día.
 */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  // getUTCDay: 0 = domingo. Se retrocede hasta el lunes.
  const diaSemana = base.getUTCDay();
  const retroceso = diaSemana === 0 ? 6 : diaSemana - 1;
  return addDays(date, -retroceso);
}

/** Los siete días de una semana, de lunes a domingo. */
export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Nombre corto del día, con mayúscula inicial. */
export function weekdayName(date: string, locale = "es-CL"): string {
  const [y, m, d] = date.split("-").map(Number);
  const nombre = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(locale, {
    timeZone: "UTC",
    weekday: "long",
  });
  return nombre.charAt(0).toUpperCase() + nombre.slice(1);
}

/** Día del mes, para la cabecera de cada columna. */
export function dayOfMonth(date: string): number {
  return Number(date.split("-")[2]);
}

/** Rango legible de una semana: "1 al 7 de septiembre". */
export function weekLabel(start: string, locale = "es-CL"): string {
  const fin = addDays(start, 6);
  const [, mesInicio] = start.split("-");
  const [, mesFin] = fin.split("-");
  const mes = (fecha: string) => {
    const [y, m, d] = fecha.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(locale, {
      timeZone: "UTC",
      month: "long",
    });
  };
  if (mesInicio === mesFin) {
    return `${dayOfMonth(start)} al ${dayOfMonth(fin)} de ${mes(start)}`;
  }
  return `${dayOfMonth(start)} de ${mes(start)} al ${dayOfMonth(fin)} de ${mes(fin)}`;
}
