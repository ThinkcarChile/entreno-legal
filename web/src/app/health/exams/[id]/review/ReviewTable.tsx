"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmReview, type ReviewDecision } from "../../../actions";
import { Button, ButtonOutline, Card, Chip, EmptyState, ErrorNote, Icon } from "@/components/ui";

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

const CAMPO =
  "w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-sm py-2 font-body-sm text-body-sm min-h-[44px]";

/**
 * §10: cada fila se CONFIRMA, EDITA o DESCARTA. Las dudosas (sin biomarcador,
 * sin unidad, sin valor o con confianza desconocida) van destacadas, y
 * "Confirmar todo" solo se habilita cuando cada fila pendiente tiene forma
 * válida. El estado nunca depende solo del color (§94): siempre lleva texto.
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

  /** Qué le falta a la fila. Vacío = está lista. */
  const faltantes = (fila: Fila): string[] => {
    const v = efectiva(fila);
    const f: string[] = [];
    if (v.biomarkerId === null) f.push("biomarcador");
    if (v.value === null) f.push("valor");
    if (v.unit === null) f.push("unidad");
    // Confianza DESCONOCIDA cuenta como dudosa (dirección conservadora).
    if (f.length === 0 && (fila.confidence === null || fila.confidence < 0.7)) {
      f.push("confianza baja");
    }
    return f;
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
      <EmptyState icon="task_alt">No quedan filas pendientes de revisión en este examen.</EmptyState>
    );
  }

  return (
    <section className="space-y-md">
      {pendientes.map((fila) => {
        const v = efectiva(fila);
        const falta = faltantes(fila);
        const descartada = descartadas.has(fila.id);
        const editada = Object.keys(ediciones[fila.id] ?? {}).length > 0;
        return (
          <Card
            key={fila.id}
            as="article"
            className={`p-md ${descartada ? "opacity-50" : falta.length > 0 ? "ring-1 ring-secondary-fixed-dim" : ""}`}
          >
            <div className="mb-sm flex flex-wrap items-start justify-between gap-sm">
              <p className="min-w-0 font-body-md text-body-md font-semibold">
                {fila.rawLabel ?? "(sin etiqueta)"}
              </p>
              <div className="flex shrink-0 items-center gap-sm">
                <span className="font-label-md text-label-md text-on-surface-variant">
                  confianza{" "}
                  {fila.confidence !== null ? `${Math.round(fila.confidence * 100)}%` : "—"}
                </span>
                {descartada ? (
                  <Chip>descartada</Chip>
                ) : falta.length > 0 ? (
                  <Chip tono="atencion" icon="priority_high">
                    revisar: {falta.join(", ")}
                  </Chip>
                ) : (
                  <Chip tono="primario" icon="check">
                    lista
                  </Chip>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-sm sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="mb-1 block font-label-md text-label-md text-on-surface-variant">
                  Biomarcador
                </span>
                <select
                  value={v.biomarkerId ?? ""}
                  onChange={(ev) => editar(fila.id, "biomarkerId", ev.target.value || null)}
                  disabled={descartada}
                  className={CAMPO}
                >
                  <option value="">Elige…</option>
                  {biomarcadores.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.nombre}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block font-label-md text-label-md text-on-surface-variant">
                  Valor
                </span>
                <input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={v.value ?? ""}
                  onChange={(ev) =>
                    editar(fila.id, "value", ev.target.value === "" ? null : Number(ev.target.value))
                  }
                  disabled={descartada}
                  className={CAMPO}
                />
              </label>
              <label className="block">
                <span className="mb-1 block font-label-md text-label-md text-on-surface-variant">
                  Unidad
                </span>
                <input
                  type="text"
                  value={v.unit ?? ""}
                  placeholder="desconocida"
                  onChange={(ev) => editar(fila.id, "unit", ev.target.value || null)}
                  disabled={descartada}
                  className={CAMPO}
                />
              </label>
              <div>
                <span className="mb-1 block font-label-md text-label-md text-on-surface-variant">
                  Rango del laboratorio
                </span>
                <p className="rounded-lg bg-surface-container px-sm py-2 font-body-sm text-body-sm">
                  {fila.referenceText ??
                    (fila.referenceLow !== null && fila.referenceHigh !== null
                      ? `${fila.referenceLow}–${fila.referenceHigh}`
                      : "no impreso (desconocido)")}
                </p>
              </div>
            </div>

            {fila.snippet && (
              <p className="mt-sm rounded-lg bg-surface-container px-sm py-2 font-body-sm text-body-sm text-on-surface-variant">
                <Icon name="format_quote" className="mr-1 align-middle text-[16px]" />
                {fila.snippet}
              </p>
            )}

            <div className="mt-md flex flex-wrap gap-sm">
              <Button disabled={pending || descartada} onClick={() => enviar([decisionDe(fila)])}>
                {editada ? "Guardar edición" : "Confirmar"}
              </Button>
              <ButtonOutline
                disabled={pending}
                onClick={() =>
                  setDescartadas((prev) => {
                    const s = new Set(prev);
                    if (s.has(fila.id)) s.delete(fila.id);
                    else s.add(fila.id);
                    return s;
                  })
                }
              >
                {descartada ? "Recuperar" : "Descartar"}
              </ButtonOutline>
            </div>
          </Card>
        );
      })}

      {error && <ErrorNote>{error}</ErrorNote>}
      {mensaje && (
        <p className="rounded-xl bg-primary-fixed px-md py-sm font-body-sm text-body-sm text-on-primary-fixed">
          {mensaje}
        </p>
      )}

      <Button disabled={pending || !todasValidas} onClick={() => enviar(pendientes.map(decisionDe))} full>
        {todasValidas ? "Confirmar todo" : "Faltan datos en alguna fila para confirmar todo"}
      </Button>
    </section>
  );
}
