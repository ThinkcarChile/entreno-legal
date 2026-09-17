import "server-only";

import { cache } from "react";

import { redirect } from "next/navigation";

import { getData, isDemoMode } from "@/lib/data";
import { UserRole } from "@/lib/domain/enums";

import type { SessionUser } from "@/lib/domain/types";

/**
 * Sesión en el servidor.
 *
 * Protege las rutas antes de renderizar. No sustituye a RLS: es la capa de
 * experiencia, para que nadie vea una pantalla vacía en vez de un mensaje claro.
 * La autorización real sigue siendo la de la base de datos.
 */

/**
 * Quién está mirando la página.
 *
 * Se llama `getViewer` y no `getSession` a propósito: `supabase.auth.getSession()`
 * lee la cookie sin revalidarla y no sirve para autorizar. Con nombres parecidos
 * es cuestión de tiempo que alguien cambie uno por otro sin notarlo.
 *
 * `cache` deduplica la llamada dentro de una misma petición: sin esto, una
 * página con cabecera pediría la identidad dos o tres veces.
 */
export const getViewer = cache(async (): Promise<SessionUser | null> => {
  return getData().session.getSessionUser();
});

/** Exige sesión. Si no la hay, manda a entrar y vuelve luego a donde estaba. */
export async function requireUser(returnTo: string): Promise<SessionUser> {
  const session = await getViewer();
  if (!session) {
    redirect(`/entrar?next=${encodeURIComponent(returnTo)}`);
  }
  return session;
}

/** Exige sesión con el onboarding terminado. */
export async function requireOnboardedUser(returnTo: string): Promise<SessionUser> {
  const session = await requireUser(returnTo);
  if (!session.onboardingCompleted) {
    redirect(`/bienvenida?next=${encodeURIComponent(returnTo)}`);
  }
  return session;
}

/** Exige modo trabajador activo. */
export async function requireWorker(returnTo: string): Promise<SessionUser> {
  const session = await requireOnboardedUser(returnTo);
  if (!session.modes.includes(UserRole.WORKER)) {
    redirect("/cuenta/trabajador?activar=1");
  }
  return session;
}

/** Exige rol administrador. */
export async function requireAdmin(returnTo: string): Promise<SessionUser> {
  const session = await requireUser(returnTo);
  if (!session.isAdmin) redirect("/");
  return session;
}

/** En modo demostración no hay sesión: las páginas privadas lo explican. */
export function demoMode(): boolean {
  return isDemoMode();
}
