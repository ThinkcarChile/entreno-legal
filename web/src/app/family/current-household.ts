import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseMaybeRow, uuid } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";

/**
 * ÚNICO lugar donde se responde "¿cuál es MI hogar?".
 *
 * Gate 0→10 [F-1]: `household_members` filtrado por `user_id` puede devolver
 * más de una fila — hay gente que cocina en dos casas. Sin `ORDER BY`, el
 * `LIMIT 1` se queda con la fila que el planificador de PostgreSQL quiera
 * entregar ese día (depende del plan, del orden físico y de cuándo pasó el
 * último VACUUM), así que la misma persona veía una casa hoy y la otra mañana.
 * Para alguien de dos casas eso no es "una casa cualquiera": es la casa
 * equivocada, con el stock, el plan y las porciones de la otra familia.
 *
 * La corrección se aplicó una vez en `loadHouseholdMembers` y la regresión
 * volvió por la portada, por el catálogo y por el recetario, que repetían la
 * consulta a mano. Una regla copiada en cinco lugares se vuelve a separar: por
 * eso la consulta vive acá y nadie más la escribe.
 */

type Db = SupabaseClient;

/**
 * Desempate estable: siempre la membresía más antigua. Da lo mismo cuál sea
 * mientras sea SIEMPRE la misma; `created_at` es lo más cercano a "la casa de
 * la que uno viene" y no cambia sola.
 */
const DESEMPATE = "created_at";

export interface CurrentMembership {
  /** Ficha del usuario EN ESE hogar (en la otra casa es otro integrante). */
  memberId: string;
  householdId: string;
  /**
   * La fila cruda, para quien pidió columnas o embeds extra con `extraSelect`.
   * Se entrega sin interpretar: quien la pidió la valida con su propio schema
   * (regla de la casa — se valida, no se castea).
   */
  row: unknown;
}

const membershipSchema = z.object({ id: uuid, household_id: uuid });

/**
 * Membresía activa del usuario, elegida de forma DETERMINISTA.
 *
 * Recibe el `userId` en vez de llamar a `auth.getUser()` por dentro porque todo
 * punto de entrada ya lo pidió para decidir si redirige al login: hacerlo dos
 * veces es un viaje de red extra por cada carga de pantalla.
 *
 * Devuelve `null` cuando la persona todavía no tiene hogar — eso es un estado
 * legítimo (recién creó la cuenta), no un error. Un fallo de consulta sí revienta.
 *
 * @param extraSelect columnas o embeds adicionales, p. ej. `"households ( name )"`.
 */
export async function loadCurrentMembership(
  db: Db,
  userId: string,
  extraSelect?: string,
): Promise<CurrentMembership | null> {
  const columnas = extraSelect ? `id, household_id, ${extraSelect}` : "id, household_id";

  const { data, error } = await db
    .from("household_members")
    .select(columnas)
    .eq("user_id", userId)
    .eq("is_active", true)
    .order(DESEMPATE, { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new DataAccessError("hogar del usuario", error);
  if (!data) return null;

  const fila = parseMaybeRow(membershipSchema, data, "hogar del usuario")!;
  return { memberId: fila.id, householdId: fila.household_id, row: data };
}
