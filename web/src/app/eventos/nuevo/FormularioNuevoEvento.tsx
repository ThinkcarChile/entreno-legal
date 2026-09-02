"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, CAMPO, Card, ErrorNote, Notice, TextField, ToggleChip } from "@/components/ui";
import { crearEvento } from "../actions";
import { ETIQUETA_TIPO, TIPOS_EVENTO, type TipoEvento } from "../vocabulario";
import { MEAL_TYPES, MEAL_TYPE_LABELS, type MealType } from "@/domain/recipes/types";

/**
 * Crear el evento: título, tipo, fecha y QUÉ COMIDA DEL PLAN REEMPLAZA.
 *
 * El asado va primero en la lista de tipos porque es el caso que este sprint
 * resuelve entero, y porque es el que la familia crea diez veces por verano.
 *
 * La cuarta pregunta es la que evita el gasto doble: sin ella el evento nace
 * con `meal_type` en NULL, el relevo no se intenta nunca y el sábado del asado
 * la lista pide el almuerzo Y la carne. Se puede dejar SIN RESPONDER —no se
 * rellena con "almuerzo" por si acaso, que relevaría la comida equivocada— y
 * en ese caso el tablero la vuelve a pedir con el aviso de por qué importa.
 */
export function FormularioNuevoEvento({
  householdId,
  hoy,
}: {
  householdId: string;
  hoy: string;
}) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const [titulo, setTitulo] = useState("Asado");
  const [tipo, setTipo] = useState<TipoEvento>("BARBECUE");
  const [fecha, setFecha] = useState(hoy);
  const [comida, setComida] = useState<MealType | null>(null);
  const [error, setError] = useState<string | null>(null);

  function guardar() {
    setError(null);
    empezar(async () => {
      const r = await crearEvento({ householdId, titulo: titulo.trim(), tipo, fecha, comida });
      if (!r.ok || !r.id) {
        // El mensaje del servidor se muestra entero: dice qué pasó y qué hacer.
        setError(r.error ?? "No se pudo crear el evento.");
        return;
      }
      router.push(`/eventos/${r.id}`);
    });
  }

  return (
    <div className="space-y-lg">
      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="space-y-md p-md">
        <TextField label="¿Cómo se llama?" value={titulo} onChange={setTitulo} />

        <div>
          <span className="font-body-sm text-body-sm text-on-surface-variant">¿Qué es?</span>
          <div className="mt-sm flex flex-wrap gap-sm">
            {TIPOS_EVENTO.map((t) => (
              <ToggleChip key={t} activo={tipo === t} onClick={() => setTipo(t)}>
                {ETIQUETA_TIPO[t]}
              </ToggleChip>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="font-body-sm text-body-sm text-on-surface-variant">¿Qué día?</span>
          <input
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            className={`${CAMPO} mt-1`}
          />
        </label>

        <div>
          <span className="font-body-sm text-body-sm text-on-surface-variant">
            ¿Qué comida del plan reemplaza?
          </span>
          <p className="font-body-sm text-body-sm text-outline">
            Para no comprar dos veces ese día: el evento y la comida que la gente ya no se va a
            servir.
          </p>
          <div className="mt-sm flex flex-wrap gap-sm">
            {MEAL_TYPES.map((m) => (
              <ToggleChip
                key={m}
                activo={comida === m}
                onClick={() => setComida(comida === m ? null : m)}
              >
                {MEAL_TYPE_LABELS[m]}
              </ToggleChip>
            ))}
          </div>
          {comida === null && (
            <p className="mt-1 font-body-sm text-body-sm text-outline">
              Sin responder: ese día se va a comprar el evento Y la comida del plan. Se puede
              contestar después.
            </p>
          )}
        </div>

        <Button full onClick={guardar} disabled={pendiente || titulo.trim().length === 0}>
          {pendiente ? "Creando…" : "Crear y seguir"}
        </Button>
      </Card>

      <Notice icon="draw">
        Queda como borrador. Un borrador se puede borrar; desde que lo planificas, la única salida
        es cancelarlo — un evento con compras hechas no puede desaparecer sin dejar rastro.
      </Notice>
    </div>
  );
}
