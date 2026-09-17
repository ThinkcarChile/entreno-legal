import { cookies } from "next/headers";

import { createServerClient } from "@supabase/ssr";

import { env, supabasePublishableKey } from "@/lib/env";

import type { Database } from "./database.types";
import { getVerifiedUser, type VerifiedUser } from "./verified-user";

/**
 * Cliente de servidor ligado a las cookies de la petición.
 * Se crea por petición: nunca se comparte entre usuarios.
 */
export async function createClient() {
  const cookieStore = await cookies();

  if (!env.NEXT_PUBLIC_SUPABASE_URL || !supabasePublishableKey) {
    throw new Error("Supabase no está configurado en este entorno.");
  }

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Llamado desde un Server Component: el proxy ya refresca la sesión.
          }
        },
      },
    },
  );
}

/** Identidad verificada por firma. Ver `verified-user.ts`. */
export async function getCurrentUser(): Promise<VerifiedUser | null> {
  const supabase = await createClient();
  return getVerifiedUser(supabase);
}
