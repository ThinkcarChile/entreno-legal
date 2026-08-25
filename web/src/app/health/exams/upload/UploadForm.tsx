"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setConsent, uploadExam, runExtraction } from "../../actions";
import type { AccessibleMember } from "../../queries";

/**
 * Flujo §53: miembro → consentimiento explícito → archivo → subir →
 * (si consintió) extraer → derechito a la revisión. Cada error se muestra;
 * jamás un éxito falso (§89).
 */
export function UploadForm({ miembros }: { miembros: AccessibleMember[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [paso, setPaso] = useState<string | null>(null);
  const [consiente, setConsiente] = useState(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const data = new FormData(form);
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
        setPaso("Extrayendo filas del examen…");
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
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block text-sm">
        <span className="mb-1 block font-medium">¿De quién es el examen?</span>
        <select
          name="memberId"
          required
          className="w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2.5"
        >
          {miembros.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
              {m.relation === "DEPENDENT" ? " (a tu cargo)" : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium">Fecha del examen</span>
        <input
          type="date"
          name="documentDate"
          className="w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2.5"
        />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium">Laboratorio (opcional)</span>
        <input
          type="text"
          name="sourceLab"
          placeholder="Laboratorio Central"
          className="w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2.5"
        />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium">Archivo (PDF, JPG, PNG o texto · máx 5 MB)</span>
        <input
          type="file"
          name="file"
          required
          accept=".pdf,.jpg,.jpeg,.png,.txt,text/plain,application/pdf,image/jpeg,image/png"
          className="w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2.5 text-xs"
        />
      </label>

      <label className="flex items-start gap-2 rounded-xl border border-[var(--ink)]/15 bg-white p-3 text-xs">
        <input
          type="checkbox"
          name="consent"
          checked={consiente}
          onChange={(e) => setConsiente(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <strong>Consiento</strong> que este documento se procese con extracción automática para
          proponer sus biomarcadores. Sin este consentimiento el examen igual se guarda y se puede
          revisar a mano — nada se envía al modelo.
        </span>
      </label>

      {paso && <p className="text-xs text-[var(--ink)]/60">{paso}</p>}
      {error && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || miembros.length === 0}
        className="w-full rounded-full bg-[var(--accent)] px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Procesando…" : "Subir examen"}
      </button>
    </form>
  );
}
