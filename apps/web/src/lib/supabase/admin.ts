import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { env, supabaseSecretKey } from "@/lib/env";

import type { Database } from "./database.types";

/**
 * Cliente con clave de servicio.
 *
 * Omite RLS por diseño, así que solo puede usarse en código de servidor y para
 * operaciones administrativas o de conciliación de pagos. El import de
 * "server-only" hace fallar el build si alguien intenta usarlo en el cliente.
 */
export function createAdminClient() {
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !supabaseSecretKey) {
    throw new Error(
      "Falta la clave privada de Supabase. Define SUPABASE_SECRET_KEY " +
        "(o SUPABASE_SERVICE_ROLE_KEY si el proyecto aún usa las claves heredadas).",
    );
  }

  return createSupabaseClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseSecretKey,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
