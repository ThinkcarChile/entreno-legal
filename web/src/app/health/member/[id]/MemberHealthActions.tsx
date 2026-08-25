"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resolveImpact } from "../../actions";

/** Resolver impactos (§35/§36): revisar, aplicar a futuros o descartar — decide una persona. */
export function MemberHealthActions({
  impactos,
}: {
  impactos: { id: string; trigger: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function resolver(id: string, resolucion: "REVIEWED" | "DISMISSED") {
    setError(null);
    startTransition(async () => {
      const r = await resolveImpact(id, resolucion);
      if (!r.ok) {
        setError(r.error ?? "No se pudo resolver.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="mt-2 space-y-2">
      {impactos.map((i) => (
        <div key={i.id} className="flex flex-wrap items-center gap-2 text-xs">
          <span>
            {i.trigger === "LAB_RESULTS_CONFIRMED" ? "Nuevo examen confirmado" : "Cambio clínico"}
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => resolver(i.id, "REVIEWED")}
            className="rounded-full bg-amber-200 px-3 py-1 font-medium text-amber-900 disabled:opacity-50"
          >
            Marcar revisado
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => resolver(i.id, "DISMISSED")}
            className="rounded-full border border-amber-300 px-3 py-1 disabled:opacity-50"
          >
            Descartar
          </button>
        </div>
      ))}
      {error && (
        <p className="rounded-lg bg-red-50 px-2 py-1.5 text-xs text-red-800" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
