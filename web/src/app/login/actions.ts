"use server";

import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { signInSchema } from "@/domain/family/schemas";
import { destinoInterno } from "@/lib/auth/destino";
import { origenPublico } from "@/lib/auth/origen";
import { alLogin } from "@/lib/auth/avisos";
import { registrarError } from "@/lib/observabilidad";

/**
 * LA PUERTA: entrar, crear cuenta, salir.
 *
 * Tres decisiones que antes no estaban y ahora sí:
 *
 *   - El `next` pasa por `destinoInterno`, el ÚNICO validador de destinos. La
 *     regla privada que vivía acá (`startsWith("/") && !startsWith("//")`)
 *     aceptaba `/\evil.com`. Ver `lib/auth/destino.ts`.
 *   - Por la URL viajan CÓDIGOS de aviso, no textos. El registro pasaba a la
 *     pantalla el mensaje crudo de GoTrue —"User already registered"—, que es un
 *     oráculo de qué correos existen; y cualquiera podía armar
 *     `/login?error=<lo que quiera>` con nuestro dominio en la barra.
 *   - El registro deja preparada la confirmación por correo: manda
 *     `emailRedirectTo` a `/auth/callback` con el destino adentro, y si Supabase
 *     no entrega sesión (Confirm Email activo) lo dice en vez de rebotar al
 *     login como si la clave estuviera mala.
 *
 * Con Confirm Email apagado (hoy en producción) `signUp` entrega sesión al tiro
 * y el camino es el mismo de siempre. Nada de esto activa la confirmación: eso
 * es configuración de Supabase, y se hace cuando haya dominio.
 */

export async function signIn(formData: FormData): Promise<void> {
  const next = destinoInterno(formData.get("next"));
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) redirect(alLogin("datos"));

  const supabase = await createSupabaseServer();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // Un solo mensaje para "clave mala", "correo sin confirmar" y "no existe":
    // distinguirlos le diría a quien tantea cuáles correos tienen cuenta.
    redirect(alLogin("credenciales"));
  }
  redirect(next);
}

export async function signUp(formData: FormData): Promise<void> {
  const next = destinoInterno(formData.get("next"));
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) redirect(alLogin("datos"));

  const origen = await origenPublico();
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // A dónde vuelve el correo de confirmación. El `next` va adentro, ya
      // validado: una invitación (`/invite/<token>`) sobrevive al viaje por el
      // correo y la persona aterriza donde iba.
      emailRedirectTo: `${origen}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error) {
    registrarError("auth.registro", { codigo: error.code ?? null });
    redirect(alLogin("cuenta"));
  }
  if (!data.session) {
    // Confirm Email activo: la cuenta existe pero no hay sesión hasta abrir el
    // correo. Antes esto redirigía a /family, que rebotaba al login sin decir
    // nada, y la persona creía que la clave estaba mala.
    redirect(alLogin("revisa-correo"));
  }
  redirect(next);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServer();
  await supabase.auth.signOut();
  redirect("/login");
}
