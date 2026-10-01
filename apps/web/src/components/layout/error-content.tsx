"use client";

import { useEffect } from "react";

import { RotateCw } from "lucide-react";

import { Button, ButtonLink } from "@/components/ui";

/**
 * Cuerpo de las pantallas de error.
 *
 * Igual que la 404, vive aparte porque cada sitio que la muestra la envuelve
 * distinto: dentro de la aplicación, del sitio público y del panel ya hay
 * cabecera puesta por el layout; en la raíz no hay nada.
 *
 * Nunca muestra `error.message` ni la traza: en producción Next ya reemplaza el
 * mensaje de un error de servidor por uno genérico, pero un error del
 * navegador llega tal cual, y puede traer el nombre de una tabla o un dato de
 * otra persona. Se muestra solo el `digest`, que es un resumen sin contenido y
 * es lo que permite encontrar el error en el registro del servidor cuando
 * alguien escribe a soporte.
 */
export function ErrorContent({
  error,
  retry,
  title = "Algo salió mal",
  description = "No pudimos cargar esta pantalla. Vuelve a intentarlo en un momento; si sigue igual, escríbenos.",
  homeHref = "/",
  homeLabel = "Ir al inicio",
}: {
  error: Error & { digest?: string };
  retry: () => void;
  title?: string;
  description?: string;
  homeHref?: string;
  homeLabel?: string;
}) {
  useEffect(() => {
    // Solo a la consola del navegador de quien lo vio. El servidor registra lo
    // suyo en `instrumentation.ts`.
    console.error("Error no controlado en la pantalla", error);
  }, [error]);

  return (
    <div className="container-page flex flex-col items-center py-20 text-center sm:py-28">
      <p className="text-small font-semibold text-brand-700">Error inesperado</p>
      <h1 className="mt-3 text-h1 text-ink-950">{title}</h1>
      <p className="mt-3 max-w-md text-body text-ink-600">{description}</p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Button onClick={() => retry()}>
          <RotateCw size={16} aria-hidden="true" />
          Reintentar
        </Button>
        <ButtonLink href={homeHref} variant="outline">
          {homeLabel}
        </ButtonLink>
      </div>
      {error.digest && (
        <p className="mt-6 text-caption text-ink-500">
          Si escribes a soporte, menciona esta referencia:{" "}
          <code className="font-mono text-ink-700">{error.digest}</code>
        </p>
      )}
    </div>
  );
}
