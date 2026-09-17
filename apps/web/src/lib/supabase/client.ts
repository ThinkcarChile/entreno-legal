"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "./database.types";

/**
 * Cliente de navegador. Solo usa la clave anónima, nunca la de servicio.
 * Toda la autorización real vive en las políticas RLS de PostgreSQL.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Revisa .env.local o ejecuta la aplicación en modo demo.",
    );
  }

  return createBrowserClient<Database>(url, key);
}
