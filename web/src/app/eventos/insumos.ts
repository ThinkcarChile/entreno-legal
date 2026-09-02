import type { SupabaseClient } from "@supabase/supabase-js";
import type { BbqMenuItemInput } from "@/domain/events/bbq/types";
import type { InsumosFisicos } from "./motor";
import { cargarInsumosDelEvento } from "./compras/inventario";

/**
 * LO QUE EL MOTOR NECESITA DEL MUNDO FÍSICO.
 *
 * Cuatro de las cinco piezas son lecturas de referencia (rendimientos de los
 * cortes, rendimientos por ingrediente, lo observado en la casa, la capacidad
 * de la parrilla). La quinta —el INVENTARIO DISPONIBLE— no es una lectura: es
 * un cálculo que ya tiene dueño en este proyecto, `analyzeStock`, porque
 * disponible NO es lo que hay en la despensa sino lo que hay MENOS lo que está
 * reservado para otra comida.
 *
 * Este archivo es el ENCHUFE entre la superficie del evento y la pieza de
 * compras: la superficie no sabe leer la despensa y la pieza de compras no sabe
 * nada de pantallas. El trabajo vive en `compras/inventario.ts`.
 *
 * Un error de consulta NO se convierte en insumos vacíos: `DataAccessError`
 * sube y la pantalla muestra el error. Una lista vacía de inventario significa
 * "no hay nada guardado", y el motor la usa para calcular que hay que comprarlo
 * todo; si la consulta falló, eso sería mandar a comprar comida que ya está en
 * la casa — el UNKNOWN leído como CERO (§97: ERROR no es VACÍO).
 */

export type ResultadoInsumos =
  | { ok: true; insumos: InsumosFisicos }
  | { ok: false; motivo: string };

export async function cargarInsumosFisicos(
  db: SupabaseClient,
  householdId: string,
  fechaDelEvento: string,
  menu: readonly BbqMenuItemInput[],
): Promise<ResultadoInsumos> {
  // Los cortes con identidad de catálogo son los únicos que se pueden netear
  // contra la despensa y buscar en las tablas de rendimiento. Un renglón
  // escrito a mano ("la carne que trae el tío") entra igual al menú, pero acá
  // no tiene dónde buscarse — y eso el motor ya lo declara por su lado con
  // YIELD_UNKNOWN en vez de suponer que rinde 1:1.
  const cortes = menu
    .map((i) => i.cutRef)
    .filter((ref): ref is string => ref !== null && ref.length > 0);

  const insumos = await cargarInsumosDelEvento(db, householdId, fechaDelEvento, cortes);
  return { ok: true, insumos };
}
