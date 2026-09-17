import "server-only";

import { resolveDataSource } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/verified-user";
import { DemoModeError } from "@/lib/data/repositories";

/**
 * Guardas comunes de las acciones de servidor.
 *
 * En archivo aparte porque un módulo con "use server" solo puede exportar
 * funciones asíncronas.
 */

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Necesitas iniciar sesión para hacer esto.");
    this.name = "NotAuthenticatedError";
  }
}

export function assertSupabaseMode(action: string): void {
  if (resolveDataSource() !== "supabase") throw new DemoModeError(action);
}

/**
 * Cliente autenticado más el identificador del usuario.
 *
 * El identificador sale de la firma del token verificada por `getClaims()`.
 * Nunca de un parámetro que venga del navegador.
 */
export async function requireSession() {
  assertSupabaseMode("Esta acción");

  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);

  if (!user) throw new NotAuthenticatedError();

  return { supabase, userId: user.id, email: user.email };
}

/** Sesión opcional: devuelve `null` en vez de lanzar. */
export async function optionalSession() {
  if (resolveDataSource() !== "supabase") return null;

  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return null;

  return { supabase, userId: user.id, email: user.email };
}
