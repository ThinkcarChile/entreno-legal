/**
 * Texto de búsqueda del listado de trabajos, convertido en un filtro de
 * PostgREST que no se puede romper.
 *
 * `query.or("title.ilike.%…%,description.ilike.%…%")` pega el texto tal cual en
 * la URL, y PostgREST lee la coma, los paréntesis y el punto como sintaxis del
 * filtro. Buscar «Notaría, Providencia» devolvía un error de análisis
 * (PGRST100) y el listado entero cambiaba por la página de error; «a)» devolvía
 * resultados equivocados. Aquí el término:
 *
 *   1. se recorta y se le pone tope de largo;
 *   2. se escapa para LIKE (`\`, `%` y `_` pasan a ser literales). El `*` se
 *      quita: PostgREST lo convierte en `%` dentro de un patrón LIKE antes de
 *      que ningún escape pueda impedirlo;
 *   3. va entre comillas dobles, con `\` y `"` escapados, que es como PostgREST
 *      admite comas, puntos y paréntesis dentro de un valor.
 *
 * Funciones puras: se prueban sin red (search.test.ts).
 */

/** Largo máximo del texto de búsqueda. El campo del listado tiene el mismo tope. */
export const SEARCH_QUERY_MAX = 100;

/** Sin espacios al borde ni repetidos, sin `*`, con tope. `null` si no queda nada. */
export function normalizeSearchQuery(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const term = [...raw.replace(/\*/g, " ").replace(/\s+/g, " ").trim()]
    .slice(0, SEARCH_QUERY_MAX)
    .join("")
    .trim();
  return term.length > 0 ? term : null;
}

/** El patrón `ilike` que contiene al término, ya entre comillas de PostgREST. */
export function postgrestIlikePattern(term: string): string {
  const like = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `"${`%${like}%`.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * El argumento de `.or()` para buscar el texto en el título o la descripción,
 * o `null` si no hay nada que buscar.
 */
export function jobSearchOrFilter(raw: string | null | undefined): string | null {
  const term = normalizeSearchQuery(raw);
  if (!term) return null;
  const pattern = postgrestIlikePattern(term);
  return `title.ilike.${pattern},description.ilike.${pattern}`;
}
