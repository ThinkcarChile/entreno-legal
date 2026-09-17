import type { Metadata } from "next";

import { ClipboardList } from "lucide-react";

import { ButtonLink, EmptyState } from "@/components/ui";

export const metadata: Metadata = {
  title: "Mis trabajos",
  robots: { index: false, follow: false },
};

export default function MyJobsPage() {
  return (
    <div className="container-page py-8 sm:py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Mis trabajos</h1>
      <p className="mt-2 max-w-2xl text-ink-600">
        Aquí verás tus ofertas enviadas, tus trabajos asignados y tus ganancias.
      </p>

      <EmptyState
        className="mt-8"
        icon={<ClipboardList size={28} aria-hidden="true" />}
        title="Aún no tienes trabajos asignados"
        description="Envía ofertas a los trabajos publicados en tu zona. Recuerda que necesitas tener tu identidad verificada para aceptar trabajos."
        action={<ButtonLink href="/trabajos">Buscar trabajos</ButtonLink>}
      />
    </div>
  );
}
