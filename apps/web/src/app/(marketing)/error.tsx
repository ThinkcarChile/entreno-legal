"use client";

import { ErrorContent } from "@/components/layout/error-content";

/** El layout de este grupo ya pone cabecera, pie y barra inferior. */
export default function MarketingError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <ErrorContent error={error} retry={retry} />;
}
