import type { Metadata } from "next";

import { PublishWizard } from "@/components/jobs/publish/publish-wizard";
import { getSession } from "@/lib/auth/session";
import { getData, isDemoMode } from "@/lib/data";

export const metadata: Metadata = {
  title: "Publicar un trabajo",
  description:
    "Cuenta qué necesitas, dónde y cuándo. Recibe ofertas de personas verificadas en todo Chile.",
  alternates: { canonical: "/publicar" },
};

/**
 * Publicar es la puerta de entrada del producto, así que no se pide iniciar
 * sesión antes de empezar: el asistente se completa entero y la cuenta se pide
 * al final, con el borrador ya guardado en el navegador.
 */
export default async function PublishPage() {
  const [categories, session] = await Promise.all([
    getData().categories.list(),
    getSession(),
  ]);

  return (
    <div className="container-page py-8 sm:py-12">
      <header className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">
          Publicar un trabajo
        </h1>
        <p className="mt-2 text-ink-600">
          Te toma un par de minutos. Publicar es gratis: solo pagas cuando aceptas una oferta.
        </p>
      </header>

      <div className="mx-auto mt-8 max-w-3xl">
        <PublishWizard
          categories={categories}
          canPublish={Boolean(session?.onboardingCompleted)}
          demoMode={isDemoMode()}
        />
      </div>
    </div>
  );
}
