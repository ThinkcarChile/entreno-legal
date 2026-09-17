"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "./database.types";

/**
 * Cliente de navegador.
 *
 * Solo usa la clave pública del proyecto, nunca la privada. Toda la
 * autorización real vive en las políticas RLS de PostgreSQL.
 *
 * Las dos variables se leen como literales y no a través de una función: Next
 * sustituye `process.env.NEXT_PUBLIC_*` en tiempo de compilación solo cuando
 * aparece escrito así. Un acceso dinámico llegaría al navegador como undefined.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Falta configurar Supabase. Define NEXT_PUBLIC_SUPABASE_URL y " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY en .env.local, o usa el modo demostración.",
    );
  }

  return createBrowserClient<Database>(url, key);
}
