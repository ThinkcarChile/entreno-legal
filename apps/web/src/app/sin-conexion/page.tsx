import type { Metadata } from "next";

import { WifiOff } from "lucide-react";

import { Logo } from "@/components/layout/logo";
import { ReloadButton } from "@/components/layout/reload-button";

export const metadata: Metadata = {
  title: "Sin conexión",
  robots: { index: false, follow: false },
};

/**
 * Pantalla de cortesía cuando no hay red.
 *
 * No lleva un solo dato: es la única página que el service worker guarda, y una
 * página guardada se le puede mostrar a cualquiera. Por eso no dice ni el
 * nombre de quien estaba conectado.
 */
export default function OfflinePage() {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="container-page flex h-16 items-center">
        <Logo />
      </header>
      <main className="container-page flex flex-1 items-center justify-center py-16">
        <div className="max-w-md text-center">
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-ink-100 text-ink-500">
            <WifiOff size={24} aria-hidden="true" />
          </span>
          <h1 className="mt-5 text-h2 text-ink-950">
            Te quedaste sin conexión
          </h1>
          <p className="mt-2 text-ink-600">
            No pudimos cargar esta pantalla. Tus trabajos y tus mensajes siguen ahí: vuelven a
            aparecer apenas se recupere la señal.
          </p>
          <div className="mt-6">
            <ReloadButton />
          </div>
        </div>
      </main>
    </div>
  );
}
