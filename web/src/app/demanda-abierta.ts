import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { columnsOf, dateString, parseRows, uuid } from "@/lib/supabase/rows";
import { MEAL_TYPES, MEAL_TYPE_LABELS, type MealType } from "@/domain/recipes/types";
import { weekdayName } from "@/domain/nutrition/calendar";

/**
 * EL RELEVO DEL EVENTO, DEL LADO DE LA APLICACIÓN (H20, Sprint 13).
 *
 * El sprint anterior cerró el relevo EN LA BASE —`covered_by_event_id`, la
 * vista `public.open_serving_demand`, el trigger que las escribe— y lo dejó
 * ABIERTO EN LA APLICACIÓN: ninguna consulta filtraba la marca. O sea que el
 * sábado del asado la familia compraba el almuerzo Y la carne, con una capa de
 * SQL encima que daba la sensación de estar resuelto. Esa sensación es peor que
 * no haberlo intentado.
 *
 * Este archivo es la mitad LECTORA de ese cierre: `cargarRelevosDeEventos` y
 * `textoDelRelevo` responden "qué se dejó de comprar y por culpa de qué
 * evento", para que la pantalla lo diga con palabras.
 *
 * La otra mitad —el filtro `covered_by_event_id is null`— va ESCRITA EN CADA
 * CONSULTA, y a propósito: quien lee `stock/queries.ts` tiene que ver ahí
 * mismo que la demanda futura descuenta el relevo, sin ir a buscar qué hace un
 * envoltorio. Que no se pueda olvidar lo garantiza un guardián que recorre los
 * archivos de la aplicación: `sprint13-eventos.test.ts`, "ningún cargador de
 * demanda futura de la app se olvida del filtro".
 *
 * Y decirlo no es decoración. Una lista que encoge sin explicación se lee como
 * un error del sistema, y termina con alguien comprando el almuerzo igual "por
 * si acaso" — que es exactamente el gasto doble que el relevo vino a matar.
 */

type Db = SupabaseClient;

/**
 * Un evento que releva comidas del plan, con lo que releva.
 *
 * `comida` es `null` cuando la base trae un valor de enum que esta versión no
 * conoce; el texto crudo viaja al lado y la pantalla lo muestra tal cual. Un
 * relevo que no se sabe nombrar sigue siendo un relevo y hay que decirlo.
 */
export interface RelevoDeEvento {
  eventoId: string;
  titulo: string;
  /** Fecha de la PORCIÓN relevada, que puede no ser la del evento (§26). */
  fecha: string;
  comida: MealType | null;
  comidaCruda: string;
  /** Nombres de quienes quedan relevados. Vacío nunca: sin gente no hay relevo. */
  personas: string[];
}

const relevoFila = z.object({
  projection_id: uuid,
  member_id: uuid,
  serving_date: dateString.nullable(),
  meal_type: z.string(),
  event_id: uuid,
  event_title: z.string(),
});

const SELECT_RELEVO = columnsOf(relevoFila);

/**
 * Qué comidas del plan están relevadas por un evento, entre dos fechas.
 *
 * Lee `public.event_covered_demand`, que es el complemento exacto de
 * `open_serving_demand`: entre las dos suman toda la demanda planificada, sin
 * que ninguna porción caiga en el hueco del medio.
 *
 * Los nombres se piden aparte y no como embed: la vista no lleva metadatos de
 * relación y un embed que PostgREST no sabe resolver devuelve `null` en
 * silencio, o sea "sin gente", o sea un relevo invisible otra vez.
 */
export async function cargarRelevosDeEventos(
  db: Db,
  memberIds: string[],
  desde: string,
  hasta?: string,
): Promise<RelevoDeEvento[]> {
  if (memberIds.length === 0) return [];

  let consulta = db
    .from("event_covered_demand")
    .select(SELECT_RELEVO)
    .in("member_id", memberIds)
    .gte("serving_date", desde);
  if (hasta !== undefined) consulta = consulta.lte("serving_date", hasta);

  const { data, error } = await consulta;
  if (error) throw new DataAccessError("comidas relevadas por un evento", error);

  const filas = parseRows(relevoFila, data, "comidas relevadas por un evento").filter(
    (f): f is typeof f & { serving_date: string } => f.serving_date !== null,
  );
  if (filas.length === 0) return [];

  const nombres = await cargarNombres(db, [...new Set(filas.map((f) => f.member_id))]);

  const agrupados = new Map<string, RelevoDeEvento>();
  for (const fila of filas) {
    const clave = `${fila.event_id}|${fila.serving_date}|${fila.meal_type}`;
    let relevo = agrupados.get(clave);
    if (relevo === undefined) {
      relevo = {
        eventoId: fila.event_id,
        titulo: fila.event_title,
        fecha: fila.serving_date,
        comida: (MEAL_TYPES as readonly string[]).includes(fila.meal_type)
          ? (fila.meal_type as MealType)
          : null,
        comidaCruda: fila.meal_type,
        personas: [],
      };
      agrupados.set(clave, relevo);
    }
    // Un integrante sin ficha legible NO desaparece del conteo: se nombra como
    // lo que es. Perderlo haría que el texto dijera "2 personas" cuando son 3.
    relevo.personas.push(nombres.get(fila.member_id) ?? "Un integrante");
  }

  return [...agrupados.values()]
    .map((r) => ({ ...r, personas: r.personas.sort((a, b) => a.localeCompare(b, "es")) }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.comidaCruda.localeCompare(b.comidaCruda));
}

async function cargarNombres(db: Db, memberIds: string[]): Promise<Map<string, string>> {
  const { data, error } = await db
    .from("household_members")
    .select("id, display_name")
    .in("id", memberIds);
  if (error) throw new DataAccessError("integrantes de las comidas relevadas", error);
  return new Map(
    parseRows(
      z.object({ id: uuid, display_name: z.string() }),
      data,
      "integrantes de las comidas relevadas",
    ).map((m) => [m.id, m.display_name]),
  );
}

/**
 * El aviso, en chileno y sin fórmulas: "El sábado no se compra el almuerzo:
 * hay un asado".
 *
 * Vive acá y no en cada pantalla porque el mismo hecho se dice en /shopping y
 * en el detalle del evento, y dos copias del texto se corrigen en una sola. El
 * día sale de la fecha de la porción con `weekdayName`, que es puro: acá no
 * entra ningún reloj.
 */
export function textoDelRelevo(relevo: RelevoDeEvento): string {
  const diaDeLaSemana = weekdayName(relevo.fecha);
  const comida =
    relevo.comida === null
      ? `la comida "${relevo.comidaCruda}"`
      : MEAL_TYPE_LABELS[relevo.comida].toLowerCase();
  const gente =
    relevo.personas.length === 1
      ? relevo.personas[0]!
      : `${relevo.personas.slice(0, -1).join(", ")} y ${relevo.personas[relevo.personas.length - 1]!}`;
  return `${diaDeLaSemana} no se compra ${comida} de ${gente}: está "${relevo.titulo}".`;
}
