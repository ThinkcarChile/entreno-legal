import { ChevronLeft, ChevronRight } from "lucide-react";

import { ButtonLink } from "@/components/ui";
import { pageCount } from "@/lib/utils/pagination";

/**
 * Anterior y siguiente del historial del panel.
 *
 * No numera cada página como `/trabajos`: el historial solo crece, y una fila
 * de cuarenta botones no ayuda a nadie. El ancla `#historial` evita volver al
 * principio de la pantalla, donde están los pendientes, cada vez que se avanza.
 */
export function HistoryPager({
  basePath,
  page,
  total,
  pageSize,
}: {
  basePath: string;
  page: number;
  total: number;
  pageSize: number;
}) {
  const pages = pageCount(total, pageSize);
  if (pages <= 1 && page <= 1) return null;

  const href = (target: number) =>
    target <= 1 ? `${basePath}#historial` : `${basePath}?pagina=${target}#historial`;

  return (
    <nav className="mt-6 flex items-center justify-center gap-3" aria-label="Páginas del historial">
      {page > 1 ? (
        <ButtonLink href={href(Math.min(page - 1, pages))} variant="outline" size="sm">
          <ChevronLeft size={16} aria-hidden="true" />
          Anterior
        </ButtonLink>
      ) : (
        <span className="w-24" aria-hidden="true" />
      )}
      <span className="text-small text-ink-600 tabular-nums">
        Página {page} de {pages}
      </span>
      {page < pages ? (
        <ButtonLink href={href(page + 1)} variant="outline" size="sm">
          Siguiente
          <ChevronRight size={16} aria-hidden="true" />
        </ButtonLink>
      ) : (
        <span className="w-24" aria-hidden="true" />
      )}
    </nav>
  );
}
