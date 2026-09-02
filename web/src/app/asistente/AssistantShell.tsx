"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Card, Chip, ErrorNote, Icon, Notice } from "@/components/ui";
import { Procedencia, ValorIncierto } from "@/components/assistant/piezas";
import { causaDelEstado, degradacion } from "./turnos";
import type { EstadoAsistente, RespuestaTurno, Turno } from "./turnos";

/**
 * LA PANTALLA DEL ASISTENTE.
 *
 * Dos cosas que este archivo NO hace, y son las que lo definen:
 *
 *  · NO ejecuta. El composer manda texto y recibe texto; lo que escribe en la
 *    base es la tarjeta de confirmación, que vive en otro componente y exige un
 *    token que el servidor emitió al renderizarla. "Sí, dale" escrito acá no
 *    confirma nada, y por eso tampoco lo confirma una frase escondida dentro de
 *    una boleta escaneada.
 *
 *  · NO se traga un error. Cada caída se muestra con su nombre y con un atajo a
 *    una pantalla que funciona sin proveedor. Un asistente que se queda mudo se
 *    lee como "no hay nada que decir", que es exactamente la mentira que este
 *    proyecto no permite.
 *
 * Arriba de todo van los atajos que no dependen del proveedor. Con la IA caída
 * la pantalla sigue sirviendo para algo.
 */

const ATAJOS: readonly { href: string; texto: string; icono: string }[] = [
  { href: "/inbox", texto: "¿Qué tengo pendiente?", icono: "inbox" },
  { href: "/plan", texto: "¿Qué toca esta semana?", icono: "calendar_month" },
  { href: "/prep", texto: "¿Qué cocino hoy?", icono: "restaurant" },
  { href: "/pantry", texto: "¿Qué se está venciendo?", icono: "inventory_2" },
  { href: "/shopping", texto: "¿Qué hay que comprar?", icono: "shopping_cart" },
];

let contador = 0;
function nuevoId(): string {
  contador += 1;
  return `turno-${contador}`;
}

export function AssistantShell({
  estado,
  turnosIniciales = [],
  enviar,
}: {
  estado: EstadoAsistente;
  turnosIniciales?: readonly Turno[];
  enviar: (texto: string) => Promise<RespuestaTurno>;
}) {
  const [turnos, setTurnos] = useState<readonly Turno[]>(turnosIniciales);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);

  const causaPrevia = causaDelEstado(estado);
  const puedePreguntar = causaPrevia === null;

  async function onEnviar() {
    const pregunta = texto.trim();
    if (pregunta.length === 0 || enviando) return;
    setTexto("");
    const mio: Turno = { k: "PERSONA", id: nuevoId(), texto: pregunta };
    setTurnos((previos) => [...previos, mio]);

    // Con el asistente caído no se llama a nadie: se contesta con la causa
    // real. Mandar igual para que falle allá gasta cuota y tarda más en decir
    // lo mismo.
    if (causaPrevia !== null) {
      setTurnos((previos) => [...previos, { k: "NO_PUDE", id: nuevoId(), causa: causaPrevia }]);
      return;
    }

    setEnviando(true);
    try {
      const respuesta = await enviar(pregunta);
      setTurnos((previos) => [
        ...previos,
        respuesta.ok
          ? {
              k: "ASISTENTE",
              id: nuevoId(),
              texto: respuesta.texto,
              unknowns: respuesta.unknowns,
              procedencia: respuesta.procedencia,
              proposalId: respuesta.proposalId,
            }
          : { k: "NO_PUDE", id: nuevoId(), causa: respuesta.causa },
      ]);
    } catch {
      // El error del servidor no se traga ni se muestra crudo: se nombra. No es
      // un catch vacío — cambia lo que la persona ve.
      setTurnos((previos) => [
        ...previos,
        { k: "NO_PUDE", id: nuevoId(), causa: "PROVEEDOR_CAIDO" },
      ]);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="space-y-lg">
      {/* Lo que funciona SIEMPRE, arriba de todo. */}
      <section>
        <h3 className="mb-sm font-headline-sm text-headline-sm text-on-surface">
          Respuestas directas
        </h3>
        <div className="flex flex-wrap gap-xs">
          {ATAJOS.map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-full border border-outline-variant px-4 font-body-sm text-body-sm text-on-surface-variant"
            >
              <Icon name={a.icono} className="text-[18px]" />
              {a.texto}
            </Link>
          ))}
        </div>
        <p className="mt-sm font-body-sm text-body-sm text-outline">
          Estas no pasan por la IA: las calculan los motores de la casa.
        </p>
      </section>

      {causaPrevia !== null && <AvisoDeCaida causa={causaPrevia} />}

      {/* La conversación. `aria-live` para que el lector de pantalla anuncie lo
          que llega sin que la persona tenga que ir a buscarlo. */}
      <ol aria-live="polite" className="space-y-md">
        {turnos.map((t) => (
          <li key={t.id}>
            <TurnoVisto turno={t} />
          </li>
        ))}
      </ol>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onEnviar();
        }}
        className="flex items-end gap-sm"
      >
        <label className="min-w-0 flex-1">
          <span className="font-body-sm text-body-sm text-on-surface-variant">
            Pregúntame algo de la casa
          </span>
          <input
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder="¿Cuánto pollo queda?"
            className="mt-1 min-h-[44px] w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface"
          />
        </label>
        <Button type="submit" disabled={enviando}>
          {enviando ? "Pensando…" : "Preguntar"}
        </Button>
      </form>

      {puedePreguntar && (
        <Notice icon="info">
          Puedo proponerte cambios, pero no los ejecuto: los confirmas tú en la
          tarjeta, con el botón. Escribir “sí, dale” acá no confirma nada.
        </Notice>
      )}
    </div>
  );
}

function AvisoDeCaida({ causa }: { causa: Parameters<typeof degradacion>[0] }) {
  const d = degradacion(causa);
  return (
    <div className="space-y-sm">
      <ErrorNote>
        <strong>{d.titulo}</strong> {d.detalle}
      </ErrorNote>
      <Link
        href={d.atajo.href}
        className="inline-flex min-h-[44px] items-center gap-1 font-body-sm text-body-sm font-semibold text-primary"
      >
        <Icon name="arrow_forward" className="text-[18px]" />
        {d.atajo.texto}
      </Link>
    </div>
  );
}

function TurnoVisto({ turno }: { turno: Turno }) {
  if (turno.k === "PERSONA") {
    return (
      <p className="ml-auto w-fit max-w-[28rem] rounded-2xl bg-primary-fixed px-md py-sm font-body-md text-body-md text-on-primary-fixed">
        {turno.texto}
      </p>
    );
  }

  if (turno.k === "NO_PUDE") {
    return <AvisoDeCaida causa={turno.causa} />;
  }

  return (
    <Card as="article" className="p-md">
      <Chip tono="neutro" icon="smart_toy">
        Asistente
      </Chip>
      <p className="mt-sm font-body-md text-body-md text-on-surface">{turno.texto}</p>
      {/* El bloque de lo que no se sabe va SIEMPRE que exista, en toda ruta y
          no solo en la tarjeta de riesgo alto. */}
      {turno.unknowns.length > 0 && (
        <div className="mt-sm">
          <ValorIncierto unknowns={turno.unknowns} />
        </div>
      )}
      <div className="mt-sm">
        <Procedencia fuentes={turno.procedencia} />
      </div>
      {turno.proposalId !== null && (
        <div className="mt-sm">
          <Link
            href={`/asistente/propuesta/${turno.proposalId}`}
            className="inline-flex min-h-[44px] items-center gap-1 font-body-sm text-body-sm font-semibold text-primary"
          >
            <Icon name="task_alt" className="text-[18px]" />
            Ver la propuesta y confirmar
          </Link>
        </div>
      )}
    </Card>
  );
}
