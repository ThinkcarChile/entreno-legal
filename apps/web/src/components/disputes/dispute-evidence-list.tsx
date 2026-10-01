"use client";

import { useState, useTransition } from "react";

import { ExternalLink, FileText, ImageIcon } from "lucide-react";

import { Alert } from "@/components/ui/feedback";
import { getDisputeFileUrlAction } from "@/lib/actions/disputes";
import { disputeEvidenceAuthor } from "@/lib/domain/dispute-evidence";
import type { DisputeEvidence } from "@/lib/domain/types";
import { formatDateTime } from "@/lib/utils/datetime";

/**
 * Pruebas de una disputa, de la más antigua a la más reciente.
 *
 * Igual que la evidencia del trabajo: el bucket es privado y cada archivo se
 * abre con una URL firmada de un minuto, pedida al pulsar. La acción vuelve a
 * leer la fila con la sesión de quien pulsa, así que solo firma lo que esa
 * persona puede ver.
 */
export function DisputeEvidenceList({
  items,
  timezone,
}: {
  items: readonly DisputeEvidence[];
  timezone?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (items.length === 0) {
    return (
      <p className="text-small text-ink-500">
        Todavía nadie aportó pruebas a esta disputa.
      </p>
    );
  }

  function open(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await getDisputeFileUrlAction(id);
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
      <ol className="space-y-2.5">
        {items.map((item) => (
          <li
            key={item.id}
            className="rounded-[var(--radius-control)] border border-line p-3.5 text-small"
          >
            <p className="text-caption text-ink-500">
              {disputeEvidenceAuthor(item)} · {formatDateTime(item.createdAt, timezone)}
            </p>
            {item.body && (
              <p className="mt-1.5 whitespace-pre-line text-ink-800">{item.body}</p>
            )}
            {item.file && (
              <button
                type="button"
                onClick={() => open(item.id)}
                disabled={pending}
                className="mt-2.5 flex w-full items-center gap-3 rounded-[var(--radius-control)] bg-ink-50 p-2.5 text-left hover:bg-brand-50/60 disabled:opacity-60"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-surface text-ink-500">
                  {item.file === "pdf" ? (
                    <FileText size={16} aria-hidden="true" />
                  ) : (
                    <ImageIcon size={16} aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1 font-medium text-ink-950">
                  {item.file === "pdf" ? "Abrir el PDF" : "Abrir la imagen"}
                </span>
                <ExternalLink size={15} className="shrink-0 text-ink-400" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ol>
      <p className="text-caption text-ink-500">
        Los archivos son privados: se abren con un enlace firmado que caduca en un minuto.
      </p>
    </div>
  );
}
