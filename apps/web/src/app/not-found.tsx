import Link from "next/link";

import { ButtonLink } from "@/components/ui";
import { Logo } from "@/components/layout/logo";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <header className="container-page flex h-16 items-center">
        <Link href="/" aria-label="Inicio">
          <Logo />
        </Link>
      </header>
      <main className="container-page flex flex-1 flex-col items-center justify-center py-16 text-center">
        <p className="text-sm font-semibold text-brand-600">Error 404</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-900">
          No encontramos esta página
        </h1>
        <p className="mt-3 max-w-md text-ink-600">
          Puede que el trabajo ya no esté publicado o que el enlace esté equivocado.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <ButtonLink href="/">Ir al inicio</ButtonLink>
          <ButtonLink href="/trabajos" variant="outline">
            Ver trabajos disponibles
          </ButtonLink>
        </div>
      </main>
    </div>
  );
}
