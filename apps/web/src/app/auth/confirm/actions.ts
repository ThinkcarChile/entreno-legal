"use server";

import { redirect } from "next/navigation";

import {
  authLinkErrorPath,
  classifyAuthLinkError,
  parseConfirmLink,
} from "@/lib/auth/email-link";
import { hasSupabaseCredentials } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * El botón «Continuar» de `/auth/confirm`: aquí, y solo aquí, se verifica el
 * enlace y se abre la sesión.
 *
 * Es un `POST` (acción de servidor) a propósito. Abrir el enlace ya no abre la
 * sesión: un `token_hash` que otra persona pidió para su cuenta no deja a nadie
 * dentro de ella sin un clic propio, y un filtro de correo que abre los enlaces
 * para revisarlos no lo gasta. Ver `lib/auth/email-link.ts`.
 *
 * No hace falta sesión para llamarla —quien confirma su cuenta todavía no la
 * tiene—: lo que autoriza es el `token_hash`, que Supabase comprueba.
 */
export async function confirmEmailLinkAction(formData: FormData): Promise<void> {
  const params = new URLSearchParams();
  for (const key of ["token_hash", "type", "next"]) {
    const value = formData.get(key);
    if (typeof value === "string") params.set(key, value);
  }

  const link = parseConfirmLink(params);
  if (!link.ok) redirect(authLinkErrorPath(link.type, "enlace-invalido"));
  if (!hasSupabaseCredentials) redirect(authLinkErrorPath(link.type, "auth"));

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type: link.type, token_hash: link.tokenHash });

  if (error) {
    // Ni el token ni el texto de Supabase: el código basta para diagnosticar.
    console.error("[auth/confirm] Supabase rechazó el enlace", {
      type: link.type,
      code: error.code ?? null,
      status: error.status ?? null,
    });
    redirect(authLinkErrorPath(link.type, classifyAuthLinkError(error.code)));
  }

  // La sesión ya quedó en las cookies de esta respuesta.
  redirect(link.next);
}
