import Link from "next/link";

import { NotFoundContent } from "@/components/layout/not-found-content";
import { Logo } from "@/components/layout/logo";
import { site } from "@/config/site";

/**
 * 404 de las rutas que no están dentro de ningún grupo con layout propio.
 *
 * Aquí no hay cabecera puesta por nadie, así que la pone esta página. Dentro de
 * `(app)` y `(marketing)` hay una 404 propia que solo trae el cuerpo.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="container-page flex h-(--spacing-header) items-center">
        <Link href="/" aria-label={`${site.name}, ir al inicio`}>
          <Logo />
        </Link>
      </header>
      <main className="flex flex-1 items-center">
        <NotFoundContent />
      </main>
    </div>
  );
}
