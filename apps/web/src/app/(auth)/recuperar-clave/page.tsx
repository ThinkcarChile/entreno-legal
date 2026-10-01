import type { Metadata } from "next";

import { DemoAuthNotice } from "@/components/auth/demo-auth-notice";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { Alert } from "@/components/ui/feedback";
import { authLinkMessage } from "@/lib/auth/email-link";

export const metadata: Metadata = {
  title: "Recuperar contraseña",
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ error?: string | string[] }>;
}

export default async function ResetPasswordPage({ searchParams }: PageProps) {
  const { error } = await searchParams;
  // Un enlace de contraseña nueva que no sirvió vuelve aquí con el motivo.
  const aviso = authLinkMessage(typeof error === "string" ? error : null, "recuperar");

  return (
    <div>
      <h1 className="text-h2 text-ink-950">
        Recuperar tu contraseña
      </h1>
      <p className="mt-2 text-ink-600">
        Ingresa tu correo y te enviamos un enlace para crear una nueva.
      </p>

      <div className="mt-8 space-y-5">
        {aviso && (
          <Alert tone="warning" title={aviso.title}>
            {aviso.body}
          </Alert>
        )}
        <DemoAuthNotice />
        <ResetPasswordForm />
      </div>
    </div>
  );
}
