"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clearSubstitution, saveSubstitution } from "@/app/plan/actions";

/**
 * Gate 0→10 [A-1]: aceptar un reemplazo es una DECISIÓN de la familia, y se
 * guarda como tal. Antes vivía en un query param: quien confirmaba la comida
 * desde la semana no la veía y la porción quedaba con el alimento de la receta.
 *
 * Sin comida concreta (se está mirando la receta suelta, no una comida de la
 * semana) el botón sigue siendo una vista previa por URL: no hay a qué colgar
 * la decisión.
 */
export function SubstitutionButton({
  assignmentId,
  memberId,
  componentId,
  ingredientId,
  previewHref,
  modo,
}: {
  assignmentId: string | null;
  memberId: string;
  componentId: string;
  ingredientId: string;
  previewHref: string;
  modo: "APLICAR" | "DESHACER";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!assignmentId) {
    return (
      <a
        href={previewHref}
        className={
          modo === "APLICAR"
            ? "shrink-0 rounded-full bg-amber-200 px-3 py-1 font-medium"
            : "underline"
        }
      >
        {modo === "APLICAR" ? "Aplicar" : "Deshacer"}
      </a>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const r =
              modo === "APLICAR"
                ? await saveSubstitution({ assignmentId, memberId, componentId, ingredientId })
                : await clearSubstitution({ assignmentId, memberId, componentId });
            if (!r.ok) {
              setError(r.error ?? "No se pudo guardar.");
              return;
            }
            router.refresh();
          })
        }
        className={
          modo === "APLICAR"
            ? "shrink-0 rounded-full bg-amber-200 px-3 py-1 font-medium disabled:opacity-50"
            : "underline disabled:opacity-50"
        }
      >
        {modo === "APLICAR" ? "Aplicar" : "Deshacer"}
      </button>
      {error && (
        <span className="ml-2 text-[11px] text-red-700" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
