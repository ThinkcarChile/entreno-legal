import type { Metadata } from "next";

import { DemoAuthNotice } from "@/components/auth/demo-auth-notice";
import { NewPasswordForm } from "@/components/auth/new-password-form";
import { ButtonLink } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { isDemoMode } from "@/lib/data";
import { getCurrentUser } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Nueva contraseña",
  robots: { index: false, follow: false },
};

/**
 * Aquí llega el enlace de recuperación, ya con la sesión puesta por
 * `/auth/confirm` (o por `/auth/callback`, con los correos antiguos).
 *
 * Sin sesión, el formulario no puede hacer nada: antes se dejaba escribir la
 * contraseña dos veces y recién al guardar fallaba con un mensaje genérico. Se
 * dice antes, con el camino para pedir otro enlace.
 */
export default async function NewPasswordPage() {
  const demo = isDemoMode();
  const user = demo ? null : await getCurrentUser();

  if (!demo && !user) {
    return (
      <div>
        <h1 className="text-h2 text-ink-950">Este enlace ya no sirve</h1>
        <div className="mt-6 space-y-5">
          <Alert tone="warning" title="No hay una sesión para cambiar la contraseña">
            El enlace venció, ya se usó o no se pudo abrir. Pide uno nuevo: llega en unos minutos y
            sirve una sola vez.
          </Alert>
          <ButtonLink href="/recuperar-clave" size="lg" fullWidth>
            Pedir un enlace nuevo
          </ButtonLink>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-h2 text-ink-950">Crea una contraseña</h1>
      <p className="mt-2 text-ink-600">Elige una nueva contraseña para tu cuenta.</p>
      <div className="mt-8 space-y-5">
        <DemoAuthNotice />
        <NewPasswordForm />
      </div>
    </div>
  );
}
