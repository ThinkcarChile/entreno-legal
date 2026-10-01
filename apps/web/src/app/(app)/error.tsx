"use client";

import { ErrorContent } from "@/components/layout/error-content";

/** El layout de este grupo ya pone cabecera, pie y barra inferior. */
export default function AppError({
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
      description="No pudimos cargar esta pantalla. Lo que ya habías guardado sigue ahí: vuelve a intentarlo en un momento y, si sigue igual, escríbenos."
    />
  );
}
