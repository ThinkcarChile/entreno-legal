import Link from "next/link";

/** Gate final §7: NO EXISTE es un estado propio — ni error, ni vacío. */
export default function NoExiste() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-4xl" aria-hidden>
        🔍
      </p>
      <h1 className="text-lg font-semibold">Esta página no existe</h1>
      <p className="text-sm text-[var(--ink)]/60">
        El enlace está mal escrito o apunta a algo que ya no está.
      </p>
      <Link
        href="/"
        className="rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white"
      >
        Volver al inicio
      </Link>
    </main>
  );
}
