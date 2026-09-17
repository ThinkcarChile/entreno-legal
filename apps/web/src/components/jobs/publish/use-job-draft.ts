"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { JobUrgency } from "@/lib/domain/enums";

import type { JobDraft } from "@/lib/validation/job";

const DRAFT_KEY = "hagotufila:job-draft:v1";

export const initialDraft: JobDraft = { urgency: JobUrgency.NORMAL, imageUrls: [] };

/**
 * El borrador guardado se trata como un almacén externo, no como estado inicial.
 *
 * Así el servidor renderiza el borrador vacío, el cliente adopta el guardado tras
 * hidratar y no hay ni discrepancia de hidratación ni renders en cascada.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
}

function serverSnapshot(): string | null {
  return null;
}

export interface UseJobDraftResult {
  draft: JobDraft;
  update: (patch: Partial<JobDraft>) => void;
  reset: () => void;
  clearStored: () => void;
}

export function useJobDraft(): UseJobDraftResult {
  const stored = useSyncExternalStore(subscribe, readStored, serverSnapshot);
  const [edits, setEdits] = useState<JobDraft | null>(null);

  const restored = useMemo<JobDraft>(() => {
    if (!stored) return initialDraft;
    try {
      return { ...initialDraft, ...(JSON.parse(stored) as JobDraft) };
    } catch {
      // Un borrador corrupto nunca debe impedir publicar.
      return initialDraft;
    }
  }, [stored]);

  const draft = edits ?? restored;

  // Persistir es sincronizar con un sistema externo: ese sí es trabajo de un efecto.
  useEffect(() => {
    if (!edits) return;
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(edits));
    } catch {
      // Sin almacenamiento disponible el asistente sigue funcionando.
    }
  }, [edits]);

  const update = useCallback(
    (patch: Partial<JobDraft>) => {
      setEdits((current) => ({ ...(current ?? restored), ...patch }));
    },
    [restored],
  );

  const reset = useCallback(() => setEdits(initialDraft), []);

  const clearStored = useCallback(() => {
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Sin almacenamiento no hay nada que limpiar.
    }
  }, []);

  return { draft, update, reset, clearStored };
}
