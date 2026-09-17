import type { Metadata } from "next";

import { NewPasswordForm } from "@/components/auth/new-password-form";

export const metadata: Metadata = {
  title: "Nueva contraseña",
  robots: { index: false, follow: false },
};

export default function NewPasswordPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Crea una contraseña</h1>
      <p className="mt-2 text-ink-600">Elige una nueva contraseña para tu cuenta.</p>
      <div className="mt-8">
        <NewPasswordForm />
      </div>
    </div>
  );
}
