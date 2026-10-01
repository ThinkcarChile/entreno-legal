/**
 * Textos libres que la base mete en los avisos de la contraparte: el título
 * del trabajo y el motivo de cancelación.
 *
 * La regla la impone la base (`app_private.free_text_problem`, restricciones
 * CHECK de la migración …001810) sobre cualquier camino de escritura. Esta
 * copia existe para que el formulario diga qué está mal antes de enviar; si las
 * dos se separan, manda la base. Los mensajes son los mismos a propósito.
 *
 * El motivo: el título va entre comillas en avisos como «Te seleccionaron para
 * "<título>"». Con una comilla dentro, el título cerraba la cita y el resto se
 * leía como texto de la plataforma —«HagoTuFila: verifica tu cuenta en …»—. Es
 * la misma regla que la del nombre (profile.ts), sin la parte de los espacios.
 */

/** Los mismos rangos que `personNameProblem` y que la base. */
const INVISIBLE = new RegExp(
  "[\\u0001-\\u001f\\u007f-\\u009f\\u00a0\\u00ad\\u061c\\u180e\\u2000-\\u200f" +
    "\\u2028-\\u202f\\u205f-\\u206f\\u3000\\ufeff]",
  "u",
);
const WEB = /(:\/\/|www\.|@|[a-z0-9-]\.[a-z]{2,})/i;
const QUOTES = /["«»‹›“”„‟〝〞＂]/;

/** Largos máximos, los de la base. */
export const JOB_TITLE_MAX = 120;
export const CANCELLATION_REASON_MAX = 300;

/** `null` si el texto sirve; si no, el motivo en palabras. */
export function freeTextProblem(text: string, label: string, max: number): string | null {
  // La base cuenta caracteres, no unidades UTF-16.
  if ([...text].length > max) return `${label} admite hasta ${max} caracteres.`;
  if (INVISIBLE.test(text)) {
    return `${label} no puede tener saltos de línea, tabulaciones ni caracteres invisibles.`;
  }
  if (QUOTES.test(text)) return `${label} no puede incluir comillas.`;
  if (WEB.test(text)) return `${label} no puede incluir direcciones web ni correos.`;
  if (text.toLowerCase().includes("hagotufila")) return `${label} no puede incluir «HagoTuFila».`;
  return null;
}

/**
 * Lo que se corrige sin preguntar: saltos de línea, tabulaciones y espacios
 * repetidos pasan a un espacio, y se quitan los del borde. Un motivo escrito en
 * dos líneas no es un error que valga la pena devolver.
 */
export function normalizeFreeText(text: string): string {
  return text.replace(/[\t\n\r\v\f\u2028\u2029 ]+/g, " ").trim();
}

export function jobTitleProblem(title: string): string | null {
  if ([...title].length < 10) return "El título necesita al menos 10 caracteres";
  return freeTextProblem(title, "El título", JOB_TITLE_MAX);
}

export function cancellationReasonProblem(reason: string): string | null {
  return freeTextProblem(reason, "El motivo", CANCELLATION_REASON_MAX);
}
