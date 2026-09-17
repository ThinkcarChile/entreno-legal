import type { Metadata } from "next";

import { MessageCircle } from "lucide-react";

import { ButtonLink, EmptyState } from "@/components/ui";

export const metadata: Metadata = {
  title: "Mensajes",
  robots: { index: false, follow: false },
};

export default function MessagesPage() {
  return (
    <div className="container-page py-8 sm:py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Mensajes</h1>
      <p className="mt-2 max-w-2xl text-ink-600">
        Cada trabajo tiene su propia conversación entre el cliente y el trabajador asignado.
        Nadie más puede leerla.
      </p>

      <EmptyState
        className="mt-8"
        icon={<MessageCircle size={28} aria-hidden="true" />}
        title="Todavía no tienes conversaciones"
        description="El chat se habilita cuando aceptas una oferta. Incluirá texto, imágenes y avisos automáticos del sistema en tiempo real."
        action={<ButtonLink href="/trabajos">Ver trabajos disponibles</ButtonLink>}
      />
    </div>
  );
}
