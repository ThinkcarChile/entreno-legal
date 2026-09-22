"use client";

import { useState, useTransition } from "react";

import { ExternalLink, FileText, ImageIcon } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { getEvidenceUrlAction } from "@/lib/actions/assignment";
import type { JobTimelineEntry } from "@/lib/domain/types";
import { formatTime } from "@/lib/utils/datetime";

/**
 * Archivos adjuntos al trabajo.
 *
 * El bucket es privado y las URL se firman al abrir, con un minuto de vida.
 * No se guarda ninguna URL en la base ni se pinta una imagen con `src` fijo: una
 * dirección permanente a un archivo privado deja de ser privada en cuanto
 * alguien la copia.
 */
export function EvidenceGallery({
  entries,
  timezone,
}: {
  entries: readonly JobTimelineEntry[];
  timezone: string;
}) {
  const files = entries.filter((entry) => entry.storagePath);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (files.length === 0) {
    return (
      <p className="text-small text-ink-500">
        Todavía no hay fotos ni comprobantes de este trabajo.
      </p>
    );
  }

  function open(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await getEvidenceUrlAction(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      window.open(result.data.url, "_blank", "noopener,noreferrer");
    });
  }

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {files.map((file) => {
          const isPdf = file.mimeType === "application/pdf";
          return (
            <li key={file.id}>
              <button
                type="button"
                onClick={() => open(file.id)}
                disabled={pending}
                className="flex w-full items-center gap-3 rounded-[var(--radius-control)] border border-line p-3 text-left hover:border-brand-300 hover:bg-brand-50/40 disabled:opacity-60"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-ink-100 text-ink-500">
                  {isPdf ? (
                    <FileText size={17} aria-hidden="true" />
                  ) : (
                    <ImageIcon size={17} aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small font-medium text-ink-950">
                    {file.title}
                  </span>
                  <span className="block text-caption text-ink-500">
                    {formatTime(file.occurredAt, timezone)}
                    {file.authorName ? ` · ${file.authorName}` : ""}
                  </span>
                </span>
                <ExternalLink size={15} className="shrink-0 text-ink-400" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-caption text-ink-500">
        Los archivos son privados: se abren con un enlace firmado que caduca en un minuto.
      </p>
    </div>
  );
}
