import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";

import type { Database } from "./database.types";

/**
 * Cliente con clave de servicio.
 *
 * Omite RLS por diseño, así que solo puede usarse en código de servidor y para
 * operaciones administrativas o de conciliación de pagos. El import de
 * "server-only" hace fallar el build si alguien intenta usarlo en el cliente.
 */
export function createAdminClient() {
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY para operaciones administrativas.",
    );
  }

  return createSupabaseClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
