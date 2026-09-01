"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonOutline, Card, EmptyState, ErrorNote, Icon, TextField } from "@/components/ui";
import { declareCondition, removeCondition } from "../../actions";

/**
 * Condiciones declaradas: la parte del módulo de salud que faltaba.
 *
 * La tabla `member_conditions` existió meses sin un solo escritor ni lector —
 * no había forma de anotar que alguien es diabético. Este panel la conecta,
 * respetando la regla que su propio comentario declara: una condición es
 * CONTEXTO. No crea límites, no cambia el plan, no filtra recetas. Los límites
 * nacen únicamente de restricciones confirmadas con fuente, en su sección.
 */
export function ConditionsPanel({
  memberId,
  puedeEscribir,
  condiciones,
}: {
  memberId: string;
  puedeEscribir: boolean;
  condiciones: {
    id: string;
    label: string;
    confirmed_by: string | null;
    notes: string | null;
    declared_at: string;
  }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [label, setLabel] = useState("");
  const [confirmadaPor, setConfirmadaPor] = useState("");
  const [notas, setNotas] = useState("");
  /** Quitar pide un segundo toque sobre la MISMA fila: sin diálogos, sin sustos. */
  const [confirmandoQuitar, setConfirmandoQuitar] = useState<string | null>(null);

  function declarar() {
    setError(null);
    startTransition(async () => {
      const r = await declareCondition({
        memberId,
        label,
        confirmedBy: confirmadaPor || null,
        notes: notas || null,
      });
      if (!r.ok) {
        setError(r.error ?? "No se pudo declarar.");
        return;
      }
      setLabel("");
      setConfirmadaPor("");
      setNotas("");
      setAbierto(false);
      router.refresh();
    });
  }

  function quitar(id: string) {
    if (confirmandoQuitar !== id) {
      setConfirmandoQuitar(id);
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await removeCondition(id, memberId);
      setConfirmandoQuitar(null);
      if (!r.ok) {
        setError(r.error ?? "No se pudo quitar.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-sm">
      {condiciones.length === 0 ? (
        <EmptyState icon="medical_information">
          Sin condiciones declaradas. Declarar una acá no cambia el plan ni las recetas: es
          contexto para quien mira esta ficha. Los límites de verdad viven en las restricciones.
        </EmptyState>
      ) : (
        <Card className="p-md">
          <ul>
            {condiciones.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-baseline gap-x-md gap-y-1 border-b border-outline-variant/40 py-sm last:border-0"
              >
                <span className="font-body-md text-body-md font-semibold text-on-surface">
                  {c.label}
                </span>
                <span className="font-body-sm text-body-sm text-on-surface-variant">
                  {c.confirmed_by
                    ? `confirmada por ${c.confirmed_by}`
                    : "declarada por la familia, sin confirmación profesional"}
                </span>
                {c.notes && (
                  <span className="w-full font-body-sm text-body-sm text-on-surface-variant">
                    {c.notes}
                  </span>
                )}
                {puedeEscribir && (
                  <span className="ml-auto">
                    <ButtonOutline disabled={pending} onClick={() => quitar(c.id)}>
                      {confirmandoQuitar === c.id ? "¿Segura que la quito?" : "Quitar"}
                    </ButtonOutline>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {puedeEscribir && !abierto && (
        <ButtonOutline disabled={pending} onClick={() => setAbierto(true)}>
          <Icon name="add" className="text-[18px]" />
          Declarar una condición
        </ButtonOutline>
      )}

      {puedeEscribir && abierto && (
        <Card className="space-y-sm p-md">
          <TextField
            label="Condición"
            value={label}
            onChange={setLabel}
            placeholder="Diabetes tipo 2, hipertensión, celiaquía…"
            hint="Escríbela como te la dijeron. No cambia el plan: los límites se declaran aparte, con su fuente."
          />
          <TextField
            label="¿Quién la confirmó? (opcional)"
            value={confirmadaPor}
            onChange={setConfirmadaPor}
            placeholder="Dra. Rojas, Hospital Sótero del Río"
            hint="Si un profesional la diagnosticó, deja dicho quién. Si es una sospecha de la familia, déjalo vacío."
          />
          <TextField
            label="Notas (opcional)"
            value={notas}
            onChange={setNotas}
            multiline
          />
          <div className="flex gap-sm">
            <Button disabled={pending || label.trim().length < 3} onClick={declarar}>
              Declarar
            </Button>
            <ButtonOutline disabled={pending} onClick={() => setAbierto(false)}>
              Cancelar
            </ButtonOutline>
          </div>
        </Card>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
