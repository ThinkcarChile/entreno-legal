import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { OnboardingForm } from "@/components/auth/onboarding-form";
import { Card, CardContent } from "@/components/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Completa tu perfil",
  robots: { index: false, follow: false },
};

export default async function OnboardingPage() {
  const session = await requireUser("/bienvenida");

  // Quien ya terminó no necesita volver a pasar por aquí.
  if (session.onboardingCompleted) redirect("/trabajos");

  return (
    <div className="container-page max-w-2xl py-8 sm:py-12">
      <h1 className="text-h2 text-ink-950 sm:text-h1">
        Bienvenido a HagoTuFila
      </h1>
      <p className="mt-2 text-ink-600">
        Un par de datos y quedas listo. Tomamos solo lo necesario para que otras personas confíen
        en ti.
      </p>

      <Card className="mt-8">
        <CardContent className="sm:p-8">
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <OnboardingForm
              defaultFirstName={session.profile.firstName}
              defaultLastName={session.profile.lastNameInitial ?? ""}
            />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
