import type { Metadata } from "next";

import { SignUpForm } from "@/components/auth/sign-up-form";
import { hasSupabaseCredentials } from "@/lib/env";

export const metadata: Metadata = {
  title: "Crear cuenta",
  description: "Crea tu cuenta gratis en HagoTuFila y empieza a delegar o a ganar dinero.",
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ modo?: string }>;
}

export default async function SignUpPage({ searchParams }: PageProps) {
  const { modo } = await searchParams;
  const intent = modo === "trabajador" ? "WORKER" : "CLIENT";

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Crea tu cuenta</h1>
      <p className="mt-2 text-ink-600">Es gratis y te toma menos de un minuto.</p>
      <div className="mt-8">
        <SignUpForm enabled={hasSupabaseCredentials} defaultIntent={intent} />
      </div>
    </div>
  );
}
