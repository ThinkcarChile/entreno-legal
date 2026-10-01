"use client";

import { useEffect } from "react";
import { Inter } from "next/font/google";

import { RotateCw } from "lucide-react";

import { Logo } from "@/components/layout/logo";
import { Button, ButtonLink } from "@/components/ui";
import { site } from "@/config/site";

import "./globals.css";

// `global-error` reemplaza al layout raíz entero, con su `<html>`: no hereda
// ni la fuente ni los estilos. Sin la variable de Inter, `--font-sans` queda
// inválida y el navegador cae en su tipografía con serifas.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/**
 * Último recurso: un error en el propio layout raíz.
 *
 * Es raro —el layout raíz no lee datos—, pero si pasa no queda nada en pie,
 * ni la cabecera ni el resto de las pantallas de error: esta trae su propio
 * documento, con los estilos y la fuente importados aquí.
 *
 * Mismas reglas que `components/layout/error-content.tsx`: ni mensaje ni
 * traza, solo la referencia para soporte.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("Error no controlado en el layout raíz", error);
  }, [error]);

  return (
    <html lang="es-CL" className={inter.variable}>
      <body className="min-h-dvh bg-canvas antialiased">
        <title>{`Algo salió mal · ${site.shortName}`}</title>
        <div className="flex min-h-dvh flex-col">
          <header className="container-page flex h-16 items-center">
            <Logo />
          </header>
          <main className="container-page flex flex-1 flex-col items-center justify-center py-16 text-center">
            <p className="text-small font-semibold text-brand-700">Error inesperado</p>
            <h1 className="mt-3 text-h1 text-ink-950">Algo salió mal</h1>
            <p className="mt-3 max-w-md text-body text-ink-600">
              No pudimos cargar {site.name}. Vuelve a intentarlo en un momento; si sigue igual,
              escríbenos.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button onClick={() => retry()}>
                <RotateCw size={16} aria-hidden="true" />
                Reintentar
              </Button>
              <ButtonLink href="/" variant="outline">
                Ir al inicio
              </ButtonLink>
            </div>
            {error.digest && (
              <p className="mt-6 text-caption text-ink-500">
                Si escribes a soporte, menciona esta referencia:{" "}
                <code className="font-mono text-ink-700">{error.digest}</code>
              </p>
            )}
          </main>
        </div>
      </body>
    </html>
  );
}
