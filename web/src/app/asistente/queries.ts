import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseRows, DataShapeError } from "@/lib/supabase/rows";
import { DataAccessError } from "@/lib/supabase/unwrap";

type Db = SupabaseClient;

/**
 * ¿Puede este hogar hablar con un proveedor de IA?
 *
 * Tres respuestas, no dos. "No pude leer el consentimiento" NO es "no hay
 * consentimiento" ni —mucho peor— "sí, dale": es su propio caso, y la pantalla
 * lo dice. Un permiso que se asume por no poder leerlo es un permiso que nadie
 * dio.
 */
export type Consentimiento = "VIGENTE" | "SIN_CONSENTIMIENTO" | "NO_SE_PUDO_LEER";

const filaConsentimiento = z.object({ id: z.string() });

export async function leerConsentimientoDelHogar(
  db: Db,
  householdId: string,
): Promise<Consentimiento> {
  try {
    const { data, error } = await db
      .from("household_ai_consents")
      .select("id")
      .eq("household_id", householdId)
      .eq("scope", "ASSISTANT_HOUSEHOLD")
      .is("revoked_at", null)
      .limit(1);
    if (error) throw new DataAccessError("consentimiento de IA del hogar", error);
    const filas = parseRows(filaConsentimiento, data, "consentimiento de IA del hogar");
    return filas.length > 0 ? "VIGENTE" : "SIN_CONSENTIMIENTO";
  } catch (e) {
    // No es un catch vacío: produce un tercer estado, que es el que impide que
    // un fallo de lectura se lea como autorización.
    if (e instanceof DataShapeError || e instanceof DataAccessError) return "NO_SE_PUDO_LEER";
    return "NO_SE_PUDO_LEER";
  }
}
