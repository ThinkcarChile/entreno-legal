import type { Metadata } from "next";

import { DemoAuthNotice } from "@/components/auth/demo-auth-notice";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata: Metadata = {
  title: "Recuperar contraseña",
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return (
    <div>
      <h1 className="text-h2 text-ink-950">
        Recuperar tu contraseña
      </h1>
      <p className="mt-2 text-ink-600">
        Ingresa tu correo y te enviamos un enlace para crear una nueva.
      </p>

      <div className="mt-8 space-y-5">
        <DemoAuthNotice />
        <ResetPasswordForm />
      </div>
    </div>
  );
}
