import type { Metadata } from "next";

import { SignInForm } from "@/components/auth/sign-in-form";
import { hasSupabaseCredentials } from "@/lib/env";

export const metadata: Metadata = {
  title: "Entrar",
  description: "Accede a tu cuenta de HagoTuFila.",
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Entra a tu cuenta</h1>
      <p className="mt-2 text-ink-600">
        Sigue tus trabajos, conversa con trabajadores y revisa tus pagos.
      </p>
      <div className="mt-8">
        <SignInForm enabled={hasSupabaseCredentials} />
      </div>
    </div>
  );
}
