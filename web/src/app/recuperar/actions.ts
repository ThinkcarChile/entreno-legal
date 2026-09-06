"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { origenPublico } from "@/lib/auth/origen";
import { registrarError } from "@/lib/observabilidad";

const correoSchema = z.object({ email: z.string().trim().email() });

/**
 * "Olvidé mi contraseña": pedirle a Supabase que mande el enlace.
 *
 * LA RESPUESTA ES LA MISMA EXISTA O NO EL CORREO. `resetPasswordForEmail`
 * contesta distinto cuando el correo no tiene cuenta, y si eso llegara a la
 * pantalla, esta ruta sería la forma más cómoda de averiguar qué correos están
 * registrados: se prueba uno y se lee la respuesta. Acá se registra el código
 * del error en el servidor —para que quien opera vea un límite de envíos, por
 * ejemplo— y a la persona se le dice lo mismo siempre.
 *
 * El enlace del correo vuelve por `/auth/callback` y de ahí a
 * `/nueva-contrasena`, que sólo abre con una sesión de recuperación reciente
 * (`lib/auth/recuperacion.ts`).
 */
export async function solicitarRecuperacion(formData: FormData): Promise<void> {
  const parsed = correoSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) redirect("/recuperar?aviso=datos");

  const origen = await origenPublico();
  const supabase = await createSupabaseServer();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origen}/auth/callback?next=${encodeURIComponent("/nueva-contrasena")}`,
  });
  if (error) {
    registrarError("auth.recuperacion.solicitud", { codigo: error.code ?? null });
  }
  redirect("/recuperar?aviso=correo-enviado");
}
