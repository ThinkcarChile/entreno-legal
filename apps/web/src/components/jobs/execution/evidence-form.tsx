"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { ImagePlus, Send } from "lucide-react";

import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { addJobEvidenceAction } from "@/lib/actions/assignment";
import { EvidenceType } from "@/lib/domain/enums";

/**
 * Actualización del trabajo: texto, foto o comprobante.
 *
 * El archivo se manda al servidor y allí se comprueba lo que de verdad es
 * antes de guardarlo. Aquí solo se corta lo evidente —formato y tamaño— para
 * no hacerle subir 20 MB a alguien que está en la calle con datos móviles.
 */
const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPTED = "image/jpeg,image/png,image/webp,application/pdf";

export function EvidenceForm({ assignmentId }: { assignmentId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [type, setType] = useState<string>(EvidenceType.NOTE);
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
    if (type === EvidenceType.NOTE) setType(EvidenceType.PHOTO);
  }

  function submit(formData: FormData) {
    setError(null);
    setDone(false);
    startTransition(async () => {
      const result = await addJobEvidenceAction(assignmentId, formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      formRef.current?.reset();
      setFileName(null);
      setType(EvidenceType.NOTE);
      setDone(true);
      router.refresh();
    });
  }

  return (
    <form ref={formRef} action={submit} className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}
      {done && !error && <Alert tone="success">La actualización quedó publicada.</Alert>}

      <input type="hidden" name="evidenceType" value={type} />

      <Field label="Qué está pasando" htmlFor="evidence-title" required>
        <Input
          id="evidence-title"
          name="title"
          maxLength={120}
          required
          placeholder="Ej.: Ya estoy en la fila, hay unas 30 personas"
        />
      </Field>

      <Field label="Detalle" htmlFor="evidence-body" hint="Opcional. Lo ve el cliente.">
        <Textarea id="evidence-body" name="body" rows={2} maxLength={2000} />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tipo" htmlFor="evidence-type">
          <Select
            id="evidence-type"
            value={type}
            onChange={(event) => setType(event.target.value)}
          >
            <option value={EvidenceType.NOTE}>Nota</option>
            <option value={EvidenceType.PHOTO}>Fotografía</option>
            <option value={EvidenceType.QUEUE_STATUS}>Estado de la fila</option>
            <option value={EvidenceType.LOCATION}>Ubicación o lugar</option>
          </Select>
        </Field>

        {type === EvidenceType.QUEUE_STATUS && (
          <Field label="Personas por delante" htmlFor="evidence-queue">
            <Input id="evidence-queue" name="queueAhead" type="number" min={0} max={9999} />
          </Field>
        )}
      </div>

      <label className="flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] border border-dashed border-ink-300 px-3.5 py-3 text-small text-ink-600 hover:border-brand-300 hover:bg-brand-50/40">
        <ImagePlus size={16} className="shrink-0 text-ink-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {fileName ?? "Adjuntar foto o comprobante (opcional)"}
        </span>
        <input type="file" name="file" accept={ACCEPTED} className="sr-only" onChange={onFile} />
      </label>

      <Button type="submit" disabled={pending} fullWidth>
        {pending ? "Publicando…" : "Publicar actualización"}
        <Send size={15} aria-hidden="true" />
      </Button>
    </form>
  );
}
