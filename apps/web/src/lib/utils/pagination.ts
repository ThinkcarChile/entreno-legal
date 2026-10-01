/**
 * Paginación de las listas del panel.
 *
 * Dos necesidades distintas que antes resolvía un solo `.limit(100)`:
 *
 *  · **Lo que pide una acción** (un payout sin transferir, una disputa abierta,
 *    una devolución pendiente) se trae entero, sin tope. Con el tope, pasados
 *    cien registros los pendientes antiguos desaparecían de la única pantalla
 *    donde se atienden: justo los que más urge resolver. `fetchAllPages` lo
 *    trae por tramos, porque PostgREST corta cada respuesta en `max_rows`.
 *  · **El historial** se pagina de verdad, con `?pagina=`.
 */

/** Tamaño de página del historial. */
export const HISTORY_PAGE_SIZE = 25;

/**
 * Tamaño de cada tramo que pide `fetchAllPages`: por debajo de `max_rows`
 * (1000 en `config.toml` y por omisión en Supabase). Si un proyecto lo baja,
 * los tramos llegan más cortos y `fetchAllPages` sigue pidiendo igual.
 */
export const FETCH_ALL_CHUNK = 500;

/**
 * Página pedida en la URL. Cualquier cosa que no sea un entero positivo es la
 * primera; un número absurdo se acota para no pedirle a la base un `offset`
 * de miles de millones.
 */
export function parsePageParam(value: string | string[] | null | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d{1,6}$/.test(raw.trim())) return 1;
  const page = Number(raw.trim());
  return page >= 1 ? page : 1;
}

/** `limit` y `offset` de una página (la primera es la 1). */
export function pageWindow(page: number, pageSize = HISTORY_PAGE_SIZE): { limit: number; offset: number } {
  const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
  return { limit: pageSize, offset: (safePage - 1) * pageSize };
}

/** Cuántas páginas hay. Siempre al menos una, aunque esté vacía. */
export function pageCount(total: number, pageSize = HISTORY_PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

/** Parte una lista en trozos, para no armar un `.in()` de mil identificadores en la URL. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("El tamaño del trozo debe ser un entero positivo.");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Trae TODAS las filas de una consulta, por tramos de hasta `chunkSize`.
 *
 * `fetchRange(from, to)` es inclusivo en los dos extremos, como `.range()` de
 * supabase-js, y la consulta tiene que llevar un orden total (por ejemplo
 * `created_at` y luego `id`): sin él, dos tramos pueden repetir o saltarse una
 * fila.
 *
 * Termina solo con un tramo vacío, no con uno «corto». PostgREST recorta cada
 * respuesta a `max_rows` sin avisar: si el proyecto lo tuviera por debajo de
 * `chunkSize`, un tramo de 100 filas no significaría «no hay más», y cortar
 * ahí devolvería la lista recortada que esta función existe para evitar. El
 * precio es una consulta vacía al final.
 *
 * El tope de tramos no es un límite de negocio: existe para que una consulta
 * mal armada —una que ignore el rango— no deje la petición dando vueltas. Si
 * se alcanza, falla en voz alta en vez de devolver una lista recortada.
 */
export async function fetchAllPages<T>(
  fetchRange: (from: number, to: number) => Promise<readonly T[]>,
  { chunkSize = FETCH_ALL_CHUNK, maxChunks = 200 }: { chunkSize?: number; maxChunks?: number } = {},
): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < maxChunks; index += 1) {
    // Cada tramo empieza donde terminó lo recibido, no donde se pidió que
    // terminara: así un tramo recortado por `max_rows` no deja un hueco.
    const from = rows.length;
    const batch = await fetchRange(from, from + chunkSize - 1);
    if (batch.length === 0) return rows;
    if (batch.length > chunkSize) {
      throw new Error("La consulta devolvió más filas que el tramo pedido: ignora el rango.");
    }
    rows.push(...batch);
  }
  throw new Error(
    `La consulta siguió devolviendo filas tras ${maxChunks} tramos (${rows.length} filas); no se muestra una lista recortada como si estuviera completa.`,
  );
}
