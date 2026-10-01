"use client";

import Link from "next/link";

import { ErrorContent } from "@/components/layout/error-content";
import { Logo } from "@/components/layout/logo";
import { site } from "@/config/site";

/**
 * Error de las rutas que no tienen uno más cercano, y de los layouts de los
 * grupos: si falla la cabecera de `(app)` o de `(marketing)`, su propio
 * `error.tsx` no lo ve (un `error.tsx` no envuelve el layout de su mismo
 * segmento), así que cae aquí. Por eso esta página pone su cabecera, igual que
 * la 404 de la raíz.
 *
 * Lo que falle en el layout raíz lo atiende `global-error.tsx`.
 */
export default function RootError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="container-page flex h-(--spacing-header) items-center">
        <Link href="/" aria-label={`${site.name}, ir al inicio`}>
          <Logo />
        </Link>
      </header>
      <main className="flex flex-1 items-center">
        <ErrorContent error={error} retry={retry} />
      </main>
    </div>
  );
}
