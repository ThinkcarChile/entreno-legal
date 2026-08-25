"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmReview, type ReviewDecision } from "../../../actions";

interface Fila {
  id: string;
  biomarkerId: string | null;
  rawLabel: string | null;
  value: number | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  collectedDate: string | null;
  confidence: number | null;
  snippet: string | null;
  status: string;
}

/**
 * §10: cada fila se CONFIRMA, EDITA o DESCARTA. Las dudosas (sin biomarcador,
 * sin unidad o sin valor) van destacadas y "Confirmar todo" solo se habilita
 * cuando cada fila pendiente tiene forma válida. Estados no solo por color
 * (§94): siempre texto.
 */
export function ReviewTable({
  documentId,
  candidatos,
  biomarcadores,
}: {
  documentId: string;
  candidatos: Fila[];
  biomarcadores: { id: string; nombre: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  // Ediciones locales por fila (solo se envían al confirmar).
  const [ediciones, setEdiciones] = useState<Record<string, Partial<ReviewDecision>>>({});
  const [descartadas, setDescartadas] = useState<Set<string>>(new Set());

  const pendientes = candidatos.filter((c) => c.status === "PENDING");

  const efectiva = (fila: Fila) => {
    const e = ediciones[fila.id] ?? {};
    return {
      biomarkerId: e.biomarkerId !== undefined ? e.biomarkerId : fila.biomarkerId,
      value: e.value !== undefined ? e.value : fila.value,
      unit: e.unit !== undefined ? e.unit : fila.unit,
    };
  };

  const esDudosa = (fila: Fila) => {
    const v = efectiva(fila);
    // Confianza DESCONOCIDA = dudosa (dirección conservadora, explícita).
    return (
      v.biomarkerId === null ||
      v.value === null ||
      v.unit === null ||
      fila.confidence === null ||
      fila.confidence < 0.7
    );
  };

  const todasValidas = useMemo(
    () =>
      pendientes
        .filter((f) => !descartadas.has(f.id))
        .every((f) => {
          const v = efectiva(f);
          return v.biomarkerId !== null && v.value !== null && v.unit !== null;
        }),
    [pendientes, ediciones, descartadas],
  );

  function editar(id: string, campo: keyof ReviewDecision, valor: unknown) {
    setEdiciones((prev) => ({ ...prev, [id]: { ...prev[id], [campo]: valor } }));
  }

  function enviar(decisiones: ReviewDecision[]) {
    setError(null);
    setMensaje(null);
    startTransition(async () => {
      const r = await confirmReview(documentId, decisiones);
      if (!r.ok) {
        setError(r.error ?? "No se pudo confirmar.");
        return;
      }
      setMensaje(r.message ?? "Listo.");
      router.refresh();
    });
  }

  function decisionDe(fila: Fila): ReviewDecision {
    const e = ediciones[fila.id];
    if (descartadas.has(fila.id)) return { candidateId: fila.id, action: "DISCARD" };
    if (e && Object.keys(e).length > 0) {
      return {
        candidateId: fila.id,
        action: "EDIT",
        ...(e.biomarkerId !== undefined ? { biomarkerId: e.biomarkerId } : {}),
        ...(e.value !== undefined ? { value: e.value } : {}),
        ...(e.unit !== undefined ? { unit: e.unit } : {}),
      };
    }
    return { candidateId: fila.id, action: "CONFIRM" };
  }

  if (pendientes.length === 0) {
    return (
      <p className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4 text-sm text-[var(--ink)]/60">
        No quedan filas pendientes de revisión en este examen.
      </p>
    );
  }

  return (
    <section className="space-y-3">
      {pendientes.map((fila) => {
        const v = efectiva(fila);
        const dudosa = esDudosa(fila);
        const descartada = descartadas.has(fila.id);
        return (
          <article
            key={fila.id}
            className={`rounded-2xl border p-3 text-sm ${
              descartada
                ? "border-[var(--ink)]/10 bg-[var(--ink)]/5 opacity-60"
                : dudosa
                  ? "border-amber-300 bg-amber-50"
                  : "border-[var(--ink)]/10 bg-white"
            }`}
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <p className="font-medium">
                {fila.rawLabel ?? "(sin etiqueta)"}
                {dudosa && !descartada && (
                  <span className="ml-2 rounded-full bg-amber-200 px-2 py-0.5 text-[10px] text-amber-900">
                    revisar: {v.biomarkerId === null ? "sin biomarcador " : ""}
                    {v.unit === null ? "sin unidad " : ""}
                    {v.value === null ? "sin valor" : ""}
                    {v.biomarkerId !== null && v.unit !== null && v.value !== null
                      ? "confianza baja"
                      : ""}
                  </span>
                )}
              </p>
              <span className="shrink-0 text-[10px] text-[var(--ink)]/50">
                confianza {fila.confidence !== null ? Math.round(fila.confidence * 100) + "%" : "—"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className="text-xs">
                <span className="mb-0.5 block text-[var(--ink)]/50">Biomarcador</span>
                <select
                  value={v.biomarkerId ?? ""}
                  onChange={(e) => editar(fila.id, "biomarkerId", e.target.value || null)}
                  disabled={descartada}
                  className="w-full rounded-lg border border-[var(--ink)]/20 bg-white px-2 py-1.5"
                >
                  <option value="">Elige…</option>
                  {biomarcadores.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.nombre}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                <span className="mb-0.5 block text-[var(--ink)]/50">Valor</span>
                <input
                  type="number"
                  step="any"
                  value={v.value ?? ""}
                  onChange={(e) => editar(fila.id, "value", e.target.value === "" ? null : Number(e.target.value))}
                  disabled={descartada}
                  className="w-full rounded-lg border border-[var(--ink)]/20 bg-white px-2 py-1.5"
                />
              </label>
              <label className="text-xs">
                <span className="mb-0.5 block text-[var(--ink)]/50">Unidad</span>
                <input
                  type="text"
                  value={v.unit ?? ""}
                  placeholder="desconocida"
                  onChange={(e) => editar(fila.id, "unit", e.target.value || null)}
                  disabled={descartada}
                  className="w-full rounded-lg border border-[var(--ink)]/20 bg-white px-2 py-1.5"
                />
              </label>
              <div className="text-xs">
                <span className="mb-0.5 block text-[var(--ink)]/50">Rango del laboratorio</span>
                <p className="rounded-lg bg-[var(--paper)] px-2 py-1.5">
                  {fila.referenceText ??
                    (fila.referenceLow !== null && fila.referenceHigh !== null
                      ? `${fila.referenceLow}–${fila.referenceHigh}`
                      : "no impreso (desconocido)")}
                </p>
              </div>
            </div>

            {fila.snippet && (
              <p className="mt-2 rounded-lg bg-[var(--paper)] px-2 py-1.5 text-[11px] text-[var(--ink)]/60">
                Texto original: “{fila.snippet}”
              </p>
            )}

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={pending || descartada}
                onClick={() => enviar([decisionDe(fila)])}
                className="rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {Object.keys(ediciones[fila.id] ?? {}).length > 0 ? "Guardar edición" : "Confirmar"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  setDescartadas((prev) => {
                    const s = new Set(prev);
                    if (s.has(fila.id)) s.delete(fila.id);
                    else s.add(fila.id);
                    return s;
                  })
                }
                className="rounded-full border border-[var(--ink)]/20 px-3 py-1.5 text-xs"
              >
                {descartada ? "Recuperar" : "Descartar"}
              </button>
            </div>
          </article>
        );
      })}

      {error && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}
      {mensaje && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{mensaje}</p>}

      <button
        type="button"
        disabled={pending || !todasValidas}
        onClick={() => enviar(pendientes.map((f) => decisionDe(f)))}
        className="w-full rounded-full bg-[var(--accent)] px-4 py-3 text-sm font-medium text-white disabled:opacity-40"
      >
        {todasValidas
          ? "Confirmar todo"
          : "Confirmar todo (hay filas sin biomarcador, valor o unidad)"}
      </button>
    </section>
  );
}
