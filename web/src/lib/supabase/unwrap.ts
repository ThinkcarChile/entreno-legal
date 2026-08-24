import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Un fallo de consulta no puede disfrazarse de "no hay nada".
 *
 * Ya nos costó tres veces: el recetario aparecía vacío, la lista de integrantes
 * del hogar estuvo vacía desde el Sprint 1, y las porciones no salían — los tres
 * eran errores de PostgREST que el código descartaba y la interfaz mostraba como
 * un estado legítimo. Toda lectura de datos pasa por acá.
 */
export class DataAccessError extends Error {
  readonly code: string;
  readonly details: string | null;

  constructor(context: string, error: PostgrestError) {
    super(`${context} (${error.code}): ${error.message}`);
    this.name = "DataAccessError";
    this.code = error.code;
    this.details = error.details ?? null;
  }
}

/** Lanza si la consulta falló; devuelve los datos si no. */
export function unwrap<T>(
  result: { data: T; error: PostgrestError | null },
  context: string,
): T {
  if (result.error) throw new DataAccessError(context, result.error);
  return result.data;
}

/**
 * Igual que `unwrap`, pero para consultas donde "no hay fila" es un resultado
 * legítimo (`maybeSingle`). Sigue lanzando si hubo error de verdad.
 */
export function unwrapMaybe<T>(
  result: { data: T | null; error: PostgrestError | null },
  context: string,
): T | null {
  if (result.error) throw new DataAccessError(context, result.error);
  return result.data;
}

/** Para escrituras: no devuelve datos, pero el error tampoco puede perderse. */
export function assertOk(
  result: { error: PostgrestError | null },
  context: string,
): void {
  if (result.error) throw new DataAccessError(context, result.error);
}
