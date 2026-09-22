import { differenceInMinutes, format, formatDistanceToNowStrict, parseISO } from "date-fns";
import { es } from "date-fns/locale";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

import { site } from "@/config/site";

/**
 * Fechas.
 *
 * Todo se persiste como `timestamptz` (UTC). La presentación usa la zona del trabajo.
 * Esto importa: los trabajos overnight y de madrugada cruzan días y cambios de horario.
 */

export const DEFAULT_TIMEZONE = site.defaultTimezone;

export function toDate(value: string | Date): Date {
  return typeof value === "string" ? parseISO(value) : value;
}

export function formatDateTime(
  value: string | Date,
  timeZone: string = DEFAULT_TIMEZONE,
  pattern = "d 'de' MMMM, HH:mm",
): string {
  return formatInTimeZone(toDate(value), timeZone, pattern, { locale: es });
}

export function formatDate(
  value: string | Date,
  timeZone: string = DEFAULT_TIMEZONE,
  pattern = "EEEE d 'de' MMMM",
): string {
  return formatInTimeZone(toDate(value), timeZone, pattern, { locale: es });
}

export function formatTime(value: string | Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return formatInTimeZone(toDate(value), timeZone, "HH:mm", { locale: es });
}

export function formatRelative(value: string | Date): string {
  return formatDistanceToNowStrict(toDate(value), { locale: es, addSuffix: true });
}

/** Convierte "2026-03-14" + "05:00" en la zona indicada a un instante UTC. */
export function zonedInputToUtc(
  dateISO: string,
  time: string,
  timeZone: string = DEFAULT_TIMEZONE,
): Date {
  return fromZonedTime(`${dateISO}T${time}:00`, timeZone);
}

export function utcToZonedParts(
  value: string | Date,
  timeZone: string = DEFAULT_TIMEZONE,
): { date: string; time: string } {
  const zoned = toZonedTime(toDate(value), timeZone);
  return { date: format(zoned, "yyyy-MM-dd"), time: format(zoned, "HH:mm") };
}

export function addMinutes(value: string | Date, minutes: number): Date {
  return new Date(toDate(value).getTime() + minutes * 60_000);
}

export function minutesBetween(from: string | Date, to: string | Date): number {
  return differenceInMinutes(toDate(to), toDate(from));
}

/** "5 h", "45 min", "12 h 30 min". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

/** Franja nocturna local considerada de madrugada: de 00:00 a 06:00. */
const NIGHT_START_HOUR = 0;
const NIGHT_END_HOUR = 6;

/**
 * Proporción del trabajo que transcurre en horario de madrugada, entre 0 y 1.
 *
 * Importa para el precio: no es lo mismo una fila de 05:00 a 10:00, con una hora
 * de madrugada sobre cinco, que un turno de 22:00 a 10:00 con seis. Aplicar el
 * mismo recargo a ambos encarecería el primero sin motivo.
 */
export function overnightFraction(
  startsAt: string | Date,
  durationMinutes: number,
  timeZone: string = DEFAULT_TIMEZONE,
): number {
  if (durationMinutes <= 0) return 0;

  const start = toDate(startsAt);
  const step = 15;
  let nightSteps = 0;
  let totalSteps = 0;

  // Se muestrea el punto medio de cada tramo para no contar dos veces los bordes.
  for (let offset = 0; offset < durationMinutes; offset += step) {
    const sample = addMinutes(start, Math.min(offset + step / 2, durationMinutes));
    const hour = Number(formatInTimeZone(sample, timeZone, "H"));
    if (hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR) nightSteps += 1;
    totalSteps += 1;
  }

  return totalSteps === 0 ? 0 : nightSteps / totalSteps;
}

/** Un trabajo es nocturno si cualquier parte transcurre entre 00:00 y 06:00 locales. */
export function isOvernight(
  startsAt: string | Date,
  durationMinutes: number,
  timeZone: string = DEFAULT_TIMEZONE,
): boolean {
  return overnightFraction(startsAt, durationMinutes, timeZone) > 0;
}

export function isWeekend(value: string | Date, timeZone: string = DEFAULT_TIMEZONE): boolean {
  const day = formatInTimeZone(toDate(value), timeZone, "i");
  return day === "6" || day === "7";
}

export function localHour(value: string | Date, timeZone: string = DEFAULT_TIMEZONE): number {
  return Number(formatInTimeZone(toDate(value), timeZone, "H"));
}

/**
 * ¿Ya pasó este instante?
 *
 * Vive aquí y no en la pantalla porque leer el reloj durante el render de un
 * componente es impuro: el mismo render puede dar dos resultados distintos.
 * Encapsulado, la pantalla hace una llamada normal y el valor se calcula una
 * sola vez por petición.
 */
export function hasPassed(value: string | Date | null | undefined): boolean {
  if (!value) return false;
  return toDate(value).getTime() < Date.now();
}
