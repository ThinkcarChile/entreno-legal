"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { ImagePlus, Send } from "lucide-react";

import { Button, Field, Textarea } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { addDisputeEvidenceAction } from "@/lib/actions/disputes";

/**
 * Aportar una prueba a la disputa: un texto, un archivo, o las dos cosas.
 *
 * El archivo se comprueba de verdad en el servidor (tipo, primeros bytes y
 * tamaño) y la base vuelve a mirar quién la aporta, si la disputa sigue
 * abierta y el tope por persona. Aquí solo se corta lo evidente.
 */
const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPTED = "image/jpeg,image/png,image/webp,application/pdf";

export function DisputeEvidenceForm({
  assignmentId,
  disputeId,
}: {
  assignmentId: string;
  disputeId: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setError(null);
    if (!file) {
      setFileName(null);
      return;
    }
    if (!ACCEPTED.split(",").includes(file.type)) {
      setError("Solo aceptamos imágenes JPG, PNG, WebP o un PDF.");
      event.target.value = "";
      setFileName(null);
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("El archivo supera los 8 MB.");
      event.target.value = "";
      setFileName(null);
      return;
    }
    setFileName(file.name);
  }

  function submit(formData: FormData) {
    setError(null);
    setDone(false);
    startTransition(async () => {
      const result = await addDisputeEvidenceAction(assignmentId, disputeId, formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      formRef.current?.reset();
      setFileName(null);
      setDone(true);
      router.refresh();
    });
  }

  return (
    <form ref={formRef} action={submit} className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}
      {done && !error && <Alert tone="success">La prueba quedó adjunta a la disputa.</Alert>}

      <Field
        label="Tu versión o un dato nuevo"
        htmlFor={`dispute-evidence-body-${disputeId}`}
        hint="La leen la otra parte y el equipo que revisa el caso."
      >
        <Textarea
          id={`dispute-evidence-body-${disputeId}`}
          name="body"
          rows={3}
          maxLength={2000}
        />
      </Field>

      <label className="flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] border border-dashed border-ink-300 px-3.5 py-3 text-small text-ink-600 hover:border-brand-300 hover:bg-brand-50/40">
        <ImagePlus size={16} className="shrink-0 text-ink-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {fileName ?? "Adjuntar foto o comprobante (opcional)"}
        </span>
        <input type="file" name="file" accept={ACCEPTED} className="sr-only" onChange={onFile} />
      </label>

      <Button type="submit" disabled={pending} fullWidth>
        {pending ? "Adjuntando…" : "Adjuntar a la disputa"}
        <Send size={15} aria-hidden="true" />
      </Button>
    </form>
  );
}
