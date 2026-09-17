"use server";

import { redirect } from "next/navigation";

import { env, resolveDataSource } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { actionError, actionOk, type ActionResult } from "@/lib/utils/errors";
import { signInSchema, signUpSchema } from "@/lib/validation/auth";

/**
 * Autenticación.
 *
 * Etapa 2: correo y contraseña. La arquitectura deja lugar para Google, Apple y
 * teléfono: Supabase Auth los expone como proveedores adicionales sobre la misma
 * cuenta, así que agregarlos no cambia el modelo de datos ni estas firmas.
 */

function demoBlocked(): ActionResult<never> {
  return {
    ok: false,
    error:
      "Estás en modo demostración. Configura Supabase para crear cuentas y guardar datos.",
  };
}

export async function signUpAction(input: unknown): Promise<ActionResult<{ needsEmailConfirmation: boolean }>> {
  if (resolveDataSource() !== "supabase") return demoBlocked();

  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue.message, field: String(issue.path[0] ?? "") };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // Alimenta el trigger que crea perfil, datos privados y FilaPuntos.
      data: {
        first_name: parsed.data.firstName,
        last_name: parsed.data.lastName,
        intent: parsed.data.intent,
      },
      emailRedirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/bienvenida`,
    },
  });

  if (error) return actionError(error, "No pudimos crear la cuenta.");

  // Sin sesión inmediata significa que Supabase exige confirmar el correo.
  return actionOk({ needsEmailConfirmation: !data.session });
}

export async function signInAction(input: unknown): Promise<ActionResult<void>> {
  if (resolveDataSource() !== "supabase") return demoBlocked();

  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue.message, field: String(issue.path[0] ?? "") };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) return actionError(error, "El correo o la contraseña no coinciden.");
  return actionOk();
}

export async function signOutAction(): Promise<void> {
  if (resolveDataSource() === "supabase") {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect("/");
}

export async function requestPasswordResetAction(email: string): Promise<ActionResult<void>> {
  if (resolveDataSource() !== "supabase") return demoBlocked();

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/nueva-clave`,
  });

  // No se distingue si el correo existe: eso permitiría averiguar quién tiene
  // cuenta en la plataforma.
  if (error && error.status === 429) {
    return actionError(error, "Demasiados intentos. Espera unos minutos.");
  }
  return actionOk();
}

export async function updatePasswordAction(password: string): Promise<ActionResult<void>> {
  if (resolveDataSource() !== "supabase") return demoBlocked();

  if (password.length < 8) {
    return { ok: false, error: "La contraseña necesita al menos 8 caracteres.", field: "password" };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) return actionError(error, "No pudimos cambiar la contraseña.");
  return actionOk();
}
