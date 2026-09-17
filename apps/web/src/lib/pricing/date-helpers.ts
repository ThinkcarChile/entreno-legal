import { formatInTimeZone } from "date-fns-tz";

export {
  formatDuration,
  isOvernight,
  isWeekend,
  overnightFraction,
  localHour,
} from "@/lib/utils/datetime";

/** "2026-03-14" en la zona indicada. Usado para comparar contra feriados. */
export function formatInTimeZoneDateOnly(value: string | Date, timeZone: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return formatInTimeZone(date, timeZone, "yyyy-MM-dd");
}
