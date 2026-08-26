"use client";

import { Button, Card, Chip, Icon } from "@/components/ui";

/**
 * Gate final §7: la pantalla de ERROR es distinta del estado vacío y del 404.
 * Antes cualquier excepción del servidor mostraba el "Application error" crudo
 * de Next: ni en castellano, ni con salida. Un error NUNCA se disfraza de
 * "no hay datos" — decir "algo falló" es información; decir "no tienes nada"
 * cuando en realidad no pudimos leer, es mentir.
 *
 * Sin AppShell a propósito: el error puede venir justo del armazón, así que la
 * pantalla se sostiene sola. El ancho va explícito (`max-w-[28rem]`) porque las
 * utilidades de ancho con nombre corto resuelven a la escala de espaciado del
 * kit: darían 16 píxeles en vez de 28rem.
 */
export default function ErrorGlobal({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-container-margin py-xl">
      <Card className="flex w-full max-w-[28rem] flex-col items-center gap-md p-lg text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-error-container text-on-error-container">
          <Icon name="error" className="text-[32px]" />
        </span>

        <Chip tono="peligro" icon="report">
          Error al cargar
        </Chip>

        <div>
          <h1 className="font-headline-md text-headline-md text-on-surface">
            Algo falló de nuestro lado
          </h1>
          <p className="mt-sm font-body-md text-body-md text-on-surface-variant">
            No pudimos cargar esta parte. Tus datos no se tocaron: esto es un error al LEER, no un
            estado real de tu casa.
          </p>
        </div>

        {error.digest && (
          <p className="font-label-md text-label-md text-outline">Código: {error.digest}</p>
        )}

        <Button onClick={reset} full className="mt-sm min-h-[56px]">
          <Icon name="refresh" className="text-[18px]" />
          Reintentar
        </Button>
      </Card>
    </main>
  );
}
