import type { Metadata } from "next";

import { DemoAuthNotice } from "@/components/auth/demo-auth-notice";
import { SignUpForm } from "@/components/auth/sign-up-form";

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
      <h1 className="text-h2 text-ink-950">Crea tu cuenta</h1>
      <p className="mt-2 text-ink-600">Es gratis y te toma menos de un minuto.</p>

      <div className="mt-8 space-y-5">
        <DemoAuthNotice />
        <SignUpForm defaultIntent={intent} />
      </div>
    </div>
  );
}
