/** Formato de textos de presentación. Nunca expone datos privados. */

/** "Camila Fernández" → "Camila F." El apellido completo nunca se muestra en público. */
export function publicDisplayName(firstName: string, lastName?: string | null): string {
  const first = firstName.trim().split(/\s+/)[0] ?? firstName;
  if (!lastName) return first;
  const initial = lastName.trim().charAt(0).toUpperCase();
  return initial ? `${first} ${initial}.` : first;
}

export function initials(firstName: string, lastName?: string | null): string {
  const a = firstName.trim().charAt(0).toUpperCase();
  const b = lastName?.trim().charAt(0).toUpperCase() ?? "";
  return `${a}${b}` || "?";
}

export function formatPercent(value: number, digits = 0, locale = "es-CL"): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatNumber(value: number, locale = "es-CL"): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatRating(value: number, locale = "es-CL"): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

export function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Enmascara un RUT para vistas administrativas: "12.345.678-9" → "12.***.**8-9". */
export function maskRut(rut: string): string {
  const clean = rut.replace(/[.\s]/g, "");
  if (clean.length < 5) return "•".repeat(clean.length);
  return `${clean.slice(0, 2)}.***.**${clean.slice(-3)}`;
}
