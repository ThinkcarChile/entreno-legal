import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Identidad verificada de quien hace la petición.
 *
 * Se usa `getClaims()` y no `getSession()` ni `getUser()`:
 *
 *  - `getSession()` lee la cookie sin revalidarla. Cualquiera puede fabricar esa
 *    cookie, así que no sirve para autorizar nada del lado del servidor.
 *  - `getUser()` sí es seguro, pero consulta al servidor de Auth en cada llamada.
 *  - `getClaims()` verifica la firma del token. Con claves asimétricas lo hace
 *    localmente contra el JWKS cacheado, sin viaje de red; con claves simétricas
 *    consulta al servidor igual que `getUser()`. Es lo que recomienda la
 *    documentación vigente de Supabase para autorizar en el servidor.
 *
 * La autorización de verdad sigue estando en RLS. Esto solo determina quién
 * pregunta, para no renderizar la página de otra persona.
 */
export interface VerifiedUser {
  id: string;
  email: string | null;
}

export async function getVerifiedUser(
  supabase: SupabaseClient,
): Promise<VerifiedUser | null> {
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data?.claims) return null;

  const id = data.claims.sub;
  if (typeof id !== "string" || id.length === 0) return null;

  const email = typeof data.claims.email === "string" ? data.claims.email : null;
  return { id, email };
}
