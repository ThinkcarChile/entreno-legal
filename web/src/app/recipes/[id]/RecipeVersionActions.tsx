"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { TemplateStatus } from "@/domain/recipes/types";
import { ErrorNote } from "@/components/ui";
import { duplicateRecipe, publishVersion, startNewVersion } from "../actions";

/**
 * Acciones de una versión. La regla de K-21 se ve en la interfaz: sobre una
 * versión publicada no hay "Editar", hay "Crear versión nueva".
 */
export function RecipeVersionActions({
  templateId,
  versionId,
  status,
  isOwn,
}: {
  templateId: string;
  versionId: string;
  status: TemplateStatus;
  isOwn: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const button =
    "inline-flex items-center justify-center gap-sm rounded-full px-lg py-sm font-body-md text-body-sm font-semibold transition-transform active:scale-95 disabled:opacity-40";
  const primary = `${button} bg-primary text-on-primary`;
  const secondary = `${button} border border-outline text-on-surface-variant`;

  function run(action: () => Promise<{ ok: boolean; error?: string; templateId?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "No se pudo completar la acción.");
        return;
      }
      router.push(result.templateId ? `/recipes/${result.templateId}` : `/recipes/${templateId}`);
      router.refresh();
    });
  }

  return (
    <div className="mb-lg">
      <div className="flex flex-wrap gap-sm">
        {isOwn && status === "DRAFT" && (
          <>
            <a href={`/recipes/${templateId}/edit?v=${versionId}`} className={secondary}>
              Editar borrador
            </a>
            <button
              type="button"
              disabled={pending}
              className={primary}
              onClick={() => run(() => publishVersion(templateId, versionId))}
            >
              Publicar
            </button>
          </>
        )}

        {isOwn && status === "PUBLISHED" && (
          <button
            type="button"
            disabled={pending}
            className={secondary}
            onClick={() => run(() => startNewVersion(templateId, versionId))}
          >
            Crear versión nueva
          </button>
        )}

        <button
          type="button"
          disabled={pending}
          className={secondary}
          onClick={() => run(() => duplicateRecipe(templateId))}
        >
          {isOwn ? "Duplicar" : "Copiar a mis recetas"}
        </button>
      </div>

      {error && (
        <div className="mt-sm">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </div>
  );
}
