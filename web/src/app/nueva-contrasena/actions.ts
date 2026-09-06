"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { alLogin } from "@/lib/auth/avisos";
import { esRecuperacionVigente, reclamacionesDe } from "@/lib/auth/recuperacion";
import { registrarError } from "@/lib/observabilidad";

const claveSchema = z
  .object({
    password: z.string().min(8),
    confirmacion: z.string(),
  })
  .refine((v) => v.password === v.confirmacion);

/**
 * Guardar la clave nueva. Sólo con una sesión de RECUPERACIÓN reciente.
 *
 * La comprobación se repite acá aunque la página ya la hizo: una server action
 * es un POST alcanzable sin pasar por la página. Sin esta guarda, cualquier
 * sesión —una pestaña abierta en un computador ajeno— podría cambiar la clave.
 *
 * Al terminar se CIERRA la sesión y se manda al login con la clave nueva. La
 * sesión que abrió el correo de recuperación es de un solo propósito: cambiar
 * la clave. Dejarla viva sería dejar abierta la puerta que el correo abrió.
 */
export async function actualizarContrasena(formData: FormData): Promise<void> {
  const supabase = await createSupabaseServer();

  // Primero la identidad, verificada contra Supabase; después las
  // reclamaciones del mismo token que Supabase acaba de aceptar.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(alLogin("recuperacion-invalida"));
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session || !esRecuperacionVigente(reclamacionesDe(session.access_token))) {
    redirect(alLogin("recuperacion-invalida"));
  }

  const parsed = claveSchema.safeParse({
    password: formData.get("password"),
    confirmacion: formData.get("confirmacion"),
  });
  if (!parsed.success) redirect("/nueva-contrasena?aviso=clave-rechazada");

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    registrarError("auth.recuperacion.actualizar", { codigo: error.code ?? null });
    redirect("/nueva-contrasena?aviso=clave-rechazada");
  }

  await supabase.auth.signOut();
  redirect(alLogin("clave-actualizada"));
}
