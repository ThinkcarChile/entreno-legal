"use client";

import { ErrorContent } from "@/components/layout/error-content";

/**
 * Error dentro del panel. El layout del panel sigue en pie, con su navegación,
 * así que se puede pasar a otra sección sin volver a entrar.
 *
 * Que una pantalla del panel falle al cargar no deja nada a medias: las
 * acciones son de servidor y cada una responde por sí misma. Se dice, porque
 * lo primero que se pregunta quien administra es si quedó a medias una
 * transferencia.
 */
export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <ErrorContent
      error={error}
      retry={retry}
      title="No pudimos cargar esta sección"
      description="Cargar una pantalla no cambia nada: ninguna aprobación, transferencia ni resolución quedó a medias por este error. Vuelve a intentarlo; si sigue igual, busca la referencia de abajo en el registro del servidor."
      homeHref="/admin"
      homeLabel="Volver al resumen"
    />
  );
}
