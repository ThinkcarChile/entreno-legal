import "server-only";

import { resolveDataSource } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
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
 * El identificador sale de `auth.getUser()`, que valida el token contra el
 * servidor de Auth. Nunca de un parámetro que venga del navegador.
 */
export async function requireSession() {
  assertSupabaseMode("Esta acción");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) throw new NotAuthenticatedError();

  return { supabase, userId: data.user.id, email: data.user.email ?? null };
}

/** Sesión opcional: devuelve `null` en vez de lanzar. */
export async function optionalSession() {
  if (resolveDataSource() !== "supabase") return null;

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  return { supabase, userId: data.user.id, email: data.user.email ?? null };
}
