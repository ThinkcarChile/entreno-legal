"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setConsent, uploadExam, runExtraction } from "../../actions";
import type { AccessibleMember } from "../../queries";
import { Button, Card, ErrorNote, Icon } from "@/components/ui";

/**
 * Flujo §53: miembro → consentimiento explícito → archivo → subir →
 * (si consintió) extraer → derechito a la revisión. Cada error se muestra;
 * jamás un éxito falso (§89).
 *
 * Campos de 48 px de alto: en 320 px el pulgar necesita blanco, no elegancia.
 */
const CAMPO =
  "w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-3 font-body-md text-body-md text-on-surface min-h-[48px]";

export function UploadForm({ miembros }: { miembros: AccessibleMember[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [paso, setPaso] = useState<string | null>(null);
  const [consiente, setConsiente] = useState(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const data = new FormData(e.currentTarget);
    startTransition(async () => {
      setPaso("Subiendo el archivo…");
      const subida = await uploadExam(data);
      if (!subida.ok || !subida.id) {
        setPaso(null);
        setError(subida.error ?? "No se pudo subir.");
        return;
      }
      const documentId = subida.id;

      const consintio = data.get("consent") === "on";
      setPaso("Registrando el consentimiento…");
      const consentimiento = await setConsent(documentId, consintio);
      if (!consentimiento.ok) {
        setPaso(null);
        setError(consentimiento.error ?? "No se pudo registrar el consentimiento.");
        return;
      }

      if (consintio) {
        setPaso("Leyendo las filas del examen…");
        const extraccion = await runExtraction(documentId);
        if (!extraccion.ok) {
          // La extracción falló pero el documento EXISTE: se dice y se va a
          // revisión manual — nunca se esconde la diferencia.
          router.push(`/health/exams/${documentId}/review?extraccion=fallida`);
          return;
        }
      }
      router.push(`/health/exams/${documentId}/review`);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-md">
      <Card className="space-y-md p-md">
        <label className="block">
          <span className="mb-1 block font-body-sm text-body-sm font-semibold text-on-surface">
            ¿De quién es el examen?
          </span>
          <select name="memberId" required className={CAMPO}>
            {miembros.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
                {m.relation === "DEPENDENT" ? " (a tu cargo)" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block font-body-sm text-body-sm font-semibold text-on-surface">
            Fecha del examen
          </span>
          <input type="date" name="documentDate" className={CAMPO} />
        </label>

        <label className="block">
          <span className="mb-1 block font-body-sm text-body-sm font-semibold text-on-surface">
            Laboratorio <span className="font-normal text-on-surface-variant">(opcional)</span>
          </span>
          <input type="text" name="sourceLab" placeholder="Laboratorio Central" className={CAMPO} />
        </label>

        <label className="block">
          <span className="mb-1 block font-body-sm text-body-sm font-semibold text-on-surface">
            Archivo
          </span>
          <span className="mb-2 block font-body-sm text-body-sm text-on-surface-variant">
            PDF, JPG, PNG o texto · máximo 5 MB
          </span>
          <input
            type="file"
            name="file"
            required
            accept=".pdf,.jpg,.jpeg,.png,.txt,text/plain,application/pdf,image/jpeg,image/png"
            className={`${CAMPO} py-3 file:mr-md file:rounded-full file:border-0 file:bg-primary-fixed file:px-md file:py-2 file:font-body-sm file:text-body-sm file:font-semibold file:text-on-primary-fixed`}
          />
        </label>
      </Card>

      <Card className="p-md">
        <label className="flex items-start gap-md">
          <input
            type="checkbox"
            name="consent"
            checked={consiente}
            onChange={(ev) => setConsiente(ev.target.checked)}
            className="mt-1 h-6 w-6 shrink-0 accent-[var(--color-primary)]"
          />
          <span className="font-body-sm text-body-sm text-on-surface-variant">
            <strong className="text-on-surface">Consiento</strong> que este documento se procese
            con extracción automática para <em>proponer</em> sus biomarcadores. Sin este
            consentimiento el examen igual se guarda y se puede revisar a mano — nada se envía al
            modelo.
          </span>
        </label>
      </Card>

      {paso && (
        <p className="flex items-center gap-sm font-body-sm text-body-sm text-on-surface-variant">
          <Icon name="progress_activity" className="animate-spin text-[18px]" />
          {paso}
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}

      <Button type="submit" disabled={pending || miembros.length === 0} full>
        {pending ? "Procesando…" : "Subir examen"}
      </Button>
    </form>
  );
}
