"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorNote, HojaInferior, Notice, TextField, ToggleChip } from "@/components/ui";
import { agregarInvitadoRapido } from "../actions";
import {
  APETITOS,
  EDADES_INFANTILES,
  ETIQUETA_APETITO,
  ETIQUETA_EDAD,
  SIN_INFORMACION,
  type Apetito,
  type GrupoEdad,
} from "../vocabulario";

/**
 * "Agregar invitado" en tres campos.
 *
 * Es la operación que más se repite y la que más rápido tiene que ser: si pide
 * un formulario, la gente deja de anotar a los que llegan y la estimación se
 * calcula sobre una lista incompleta. Nombre opcional, adulto o niño, y el
 * apetito si se sabe.
 *
 * LO QUE NO PREGUNTA, a propósito: restricciones. Quedan sin declarar, que es
 * distinto de "no tiene". La pantalla del evento después muestra cuántas
 * personas están sin esa información para que el anfitrión pregunte antes de
 * comprar — un invitado del que nadie preguntó nada no puede aparecer como
 * "sin restricciones", porque eso no lo dijo nadie.
 *
 * Tampoco pregunta peso ni estatura. La cantidad de carne no se calcula con
 * eso.
 */
export function InvitadoRapido({
  eventoId,
  householdId,
  esExtra,
  etiquetaBoton,
}: {
  eventoId: string;
  householdId: string;
  /** `true` en el modo del día: llegó alguien que no estaba en la lista (§43). */
  esExtra: boolean;
  etiquetaBoton: string;
}) {
  const router = useRouter();
  const [abierta, setAbierta] = useState(false);
  const [pendiente, empezar] = useTransition();
  const [nombre, setNombre] = useState("");
  const [atajo, setAtajo] = useState<"ADULTO" | "NINO">("ADULTO");
  const [edadFina, setEdadFina] = useState<GrupoEdad | null>(null);
  const [apetito, setApetito] = useState<Apetito>("UNKNOWN");
  const [error, setError] = useState<string | null>(null);

  function limpiar() {
    setNombre("");
    setAtajo("ADULTO");
    setEdadFina(null);
    setApetito("UNKNOWN");
  }

  function guardar() {
    setError(null);
    empezar(async () => {
      const r = await agregarInvitadoRapido({
        eventoId,
        householdId,
        nombre: nombre.trim().length === 0 ? null : nombre.trim(),
        atajoEdad: atajo,
        edadFina:
          atajo === "NINO" && edadFina !== null && EDADES_INFANTILES.includes(edadFina)
            ? edadFina
            : null,
        apetito,
        esExtra,
      });
      if (!r.ok) {
        setError(r.error ?? "No se pudo agregar.");
        return;
      }
      limpiar();
      setAbierta(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button onClick={() => setAbierta(true)}>{etiquetaBoton}</Button>

      <HojaInferior titulo={etiquetaBoton} abierta={abierta} onCerrar={() => setAbierta(false)}>
        <div className="space-y-md">
          {error && <ErrorNote>{error}</ErrorNote>}

          <TextField
            label="Nombre (opcional)"
            value={nombre}
            onChange={setNombre}
            placeholder="Primo Juan"
            hint="Sin nombre también sirve: cuenta igual para la cantidad de comida."
          />

          <div>
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              ¿Adulto o niño?
            </span>
            <div className="mt-sm flex flex-wrap gap-sm">
              <ToggleChip
                activo={atajo === "ADULTO"}
                onClick={() => {
                  setAtajo("ADULTO");
                  setEdadFina(null);
                }}
              >
                Adulto
              </ToggleChip>
              <ToggleChip activo={atajo === "NINO"} onClick={() => setAtajo("NINO")}>
                Niño
              </ToggleChip>
            </div>
          </div>

          {/* Afinar la edad del niño no es un lujo: entre "niño chico" y
              "adolescente" la porción casi se dobla, así que el atajo elige el
              del medio y acá se puede corregir en un toque. */}
          {atajo === "NINO" && (
            <div>
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                ¿Más o menos de qué edad? (opcional)
              </span>
              <div className="mt-sm flex flex-wrap gap-sm">
                {EDADES_INFANTILES.map((g) => (
                  <ToggleChip
                    key={g}
                    activo={edadFina === g}
                    onClick={() => setEdadFina(edadFina === g ? null : g)}
                  >
                    {ETIQUETA_EDAD[g]}
                  </ToggleChip>
                ))}
              </div>
            </div>
          )}

          <div>
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              ¿Cuánto come? (opcional)
            </span>
            <div className="mt-sm flex flex-wrap gap-sm">
              {APETITOS.map((a) => (
                <ToggleChip key={a} activo={apetito === a} onClick={() => setApetito(a)}>
                  {a === "UNKNOWN" ? SIN_INFORMACION : ETIQUETA_APETITO[a]}
                </ToggleChip>
              ))}
            </div>
          </div>

          <Notice icon="info">
            No preguntamos alergias ni restricciones acá. Quedan sin declarar y el evento te avisa
            cuántas personas están así, para que preguntes antes de comprar.
          </Notice>

          <Button full onClick={guardar} disabled={pendiente}>
            {pendiente ? "Agregando…" : "Agregar"}
          </Button>
        </div>
      </HojaInferior>
    </>
  );
}
