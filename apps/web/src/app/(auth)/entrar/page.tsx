import type { Metadata } from "next";
import { Suspense } from "react";

import { SignInForm } from "@/components/auth/sign-in-form";
import { DemoAuthNotice } from "@/components/auth/demo-auth-notice";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = {
  title: "Entrar",
  description: "Accede a tu cuenta de HagoTuFila.",
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  return (
    <div>
      <h1 className="text-h2 text-ink-950">Entra a tu cuenta</h1>
      <p className="mt-2 text-ink-600">
        Sigue tus trabajos, conversa con trabajadores y revisa tus pagos.
      </p>

      <div className="mt-8 space-y-5">
        <DemoAuthNotice />
        <Suspense fallback={<Skeleton className="h-72 w-full" />}>
          <SignInForm />
        </Suspense>
      </div>
    </div>
  );
}
