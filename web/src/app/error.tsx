"use client";

/**
 * Gate final §7: la pantalla de ERROR es distinta del estado vacío y del 404.
 * Antes cualquier excepción del servidor mostraba el "Application error" crudo
 * de Next: ni en castellano, ni con salida. Un error NUNCA se disfraza de
 * "no hay datos" — decir "algo falló" es información; decir "no tienes nada"
 * cuando en realidad no pudimos leer, es mentir.
 */
export default function ErrorGlobal({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-4xl" aria-hidden>
        ⚠️
      </p>
      <h1 className="text-lg font-semibold">Algo falló de nuestro lado</h1>
      <p className="text-sm text-[var(--ink)]/60">
        No pudimos cargar esta parte. Tus datos no se tocaron: esto es un error
        al LEER, no un estado real de tu casa.
      </p>
      {error.digest && (
        <p className="text-[11px] text-[var(--ink)]/40">Código: {error.digest}</p>
      )}
      <button
        type="button"
        onClick={reset}
        className="rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white"
      >
        Reintentar
      </button>
    </main>
  );
}
