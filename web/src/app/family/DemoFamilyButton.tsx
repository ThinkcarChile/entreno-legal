"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { loadDemoFamily } from "./nutrition-actions";

/**
 * Carga la familia de demostración del Sprint 4 en el hogar actual. Todo lo que
 * crea es configuración editable de cada integrante, no reglas del sistema.
 */
export function DemoFamilyButton({ householdId }: { householdId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="mt-6 rounded-xl border border-dashed border-gray-300 bg-white p-4">
      <h2 className="text-sm font-semibold">Familia de demostración</h2>
      <p className="mt-1 text-xs opacity-70">
        Agrega a Paula, Sebastián, Constanza y Ricardo con configuraciones distintas (una sin
        seguimiento, otra con ayuno, otro que prefiere frito) para ver cómo cambia la porción de
        cada uno en la misma receta. Todo queda editable.
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          setMessage(null);
          startTransition(async () => {
            const result = await loadDemoFamily(householdId);
            if (!result.ok) {
              setError(result.error ?? "No se pudo cargar.");
              return;
            }
            setMessage(result.message ?? "Listo.");
            router.refresh();
          });
        }}
        className="mt-3 rounded-full border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-50"
      >
        {pending ? "Cargando…" : "Cargar familia de demostración"}
      </button>
      {message && <p className="mt-2 text-xs text-[var(--accent)]">{message}</p>}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </section>
  );
}
