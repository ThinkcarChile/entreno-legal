"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Chip, ErrorNote, Flotante, Icon, Notice, Section } from "@/components/ui";
import { marcarAsistencia, type ResultadoAccion } from "../../actions";
import type { Revision } from "../../contrato-estimacion";
import type { Participante } from "../../queries";
import {
  contadorDelDia,
  ETIQUETA_BASE,
  formatearCantidad,
  formatearGramos,
  personas,
  resumenAsistencia,
  TEXTO_MOTIVO,
  type BaseFisica,
} from "../../formato";
import { ETIQUETA_ASISTENCIA, SIN_INFORMACION } from "../../vocabulario";
import type { BbqBatches } from "@/domain/events/bbq/types";
import { InvitadoRapido } from "../InvitadoRapido";

/**
 * El día del asado.
 *
 * Tres cosas y nada más: quién llegó, quién más llegó, y en cuántas tandas hay
 * que cocinar. Todo lo demás distrae a alguien que está parado en el patio.
 *
 * Marcar asistencia acá NO reescribe la compra. Lo que se compró ya se compró,
 * y el resumen de después muestra la diferencia entre lo que se planificó y lo
 * que pasó — que es justamente el dato con el que el próximo asado se estima
 * mejor.
 */
export function TableroDelDia({
  eventoId,
  householdId,
  participantes,
  revision,
  servido,
}: {
  eventoId: string;
  householdId: string;
  participantes: Participante[];
  revision: Revision | null;
  /**
   * Lo que YA salió a la mesa, sumado desde el libro mayor. `null` = todavía no
   * se anotó nada, que no es lo mismo que cero: la carne pudo salir igual y
   * nadie haberlo apuntado.
   */
  servido: { gramos: number; base: BaseFisica } | null;
}) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function correr(accion: () => Promise<ResultadoAccion>) {
    setError(null);
    setMensaje(null);
    empezar(async () => {
      const r = await accion();
      if (!r.ok) {
        // Acá el mensaje importa el doble: si la base rechaza la marca por
        // permisos, la persona tiene que poder leer exactamente eso y pedirle
        // a alguien más que la ponga.
        setError(r.error ?? "No se pudo registrar.");
        return;
      }
      setMensaje(r.message ?? "Listo.");
      router.refresh();
    });
  }

  const asistencia = resumenAsistencia({
    llegaron: participantes.filter((p) => p.asistencia === "ATTENDED").length,
    noLlegaron: participantes.filter((p) => p.asistencia === "NO_SHOW").length,
    // Los confirmados que todavía nadie marcó. Van aparte: mientras nadie los
    // mire no llegaron ni faltaron, y meterlos con los ausentes convertía "pasé
    // lista a tres" en "los otros nueve no vinieron".
    sinMarcar: participantes.filter((p) => p.asistencia === "CONFIRMED").length,
  });

  return (
    <div className="space-y-lg">
      {mensaje && <Flotante tono="ok">{mensaje}</Flotante>}
      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="p-md">
        <p className="font-headline-md text-headline-md text-on-surface">{asistencia.texto}</p>
        {asistencia.estado === "NO_REGISTRADA" && (
          <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
            Todavía nadie pasó lista. Mientras no se marque, contamos{" "}
            {personas(asistencia.personas)} confirmadas — que es una estimación, no un conteo.
          </p>
        )}
        {asistencia.estado === "PARCIAL" && (
          <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
            Faltan {personas(asistencia.sinMarcar)} por marcar: de esas no sabemos si llegaron.
            Lo de arriba es un mínimo.
          </p>
        )}
      </Card>

      <Section
        title="¿Quién llegó?"
        hint="Un toque por persona. No cambia nada de lo que ya compraste."
      >
        <ul className="space-y-sm">
          {participantes.map((p) => (
            <li key={p.id}>
              <Card className="flex flex-wrap items-center justify-between gap-sm p-md">
                <span className="min-w-0 font-body-md text-body-md text-on-surface">
                  {p.nombre ?? "Invitado sin nombre"}
                </span>
                <span className="flex flex-wrap items-center gap-sm">
                  <Chip>{p.asistencia ? ETIQUETA_ASISTENCIA[p.asistencia] : p.asistenciaCruda}</Chip>
                  <BotonGrande
                    activo={p.asistencia === "ATTENDED"}
                    disabled={pendiente}
                    onClick={() =>
                      correr(() =>
                        marcarAsistencia({
                          eventoId,
                          participanteId: p.id,
                          asistencia: "ATTENDED",
                        }),
                      )
                    }
                  >
                    Llegó
                  </BotonGrande>
                  <BotonGrande
                    activo={p.asistencia === "NO_SHOW"}
                    disabled={pendiente}
                    onClick={() =>
                      correr(() =>
                        marcarAsistencia({
                          eventoId,
                          participanteId: p.id,
                          asistencia: "NO_SHOW",
                        }),
                      )
                    }
                  >
                    No llegó
                  </BotonGrande>
                </span>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Llegó alguien más">
        <Card className="space-y-md p-md">
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Se suma al conteo de ahora en adelante. Lo que ya compraste no se toca: la comida
            comprada es un hecho y no se recalcula hacia atrás.
          </p>
          {/* Mismo panel de tres campos que en el evento; acá nace marcado
              como extra: llegó, no fue invitado con anticipación. */}
          <InvitadoRapido
            eventoId={eventoId}
            householdId={householdId}
            esExtra
            etiquetaBoton="Llegó otra persona"
          />
        </Card>
      </Section>

      <Section title="Las tandas">
        {revision === null ? (
          <Card className="p-md">
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              No hay estimación calculada para este evento, así que no sabemos en cuántas tandas
              entra la carne.
            </p>
          </Card>
        ) : (
          <ul className="space-y-sm">
            {revision.salida.byCut.map((linea) => (
              <li key={linea.itemId}>
                <Card className="p-md">
                  <p className="font-body-md text-body-md font-semibold text-on-surface">
                    {linea.displayName}
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    Tandas: {textoTandas(linea.batches)}
                  </p>
                  <p className="font-body-sm text-body-sm text-outline">
                    Para servir: {formatearCantidad(linea.cooked)}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Cuánto queda">
        {/*
          El contador vivo del §90. Lo preparado se anota en CRUDO y lo servido
          en COCIDO, así que la resta solo aparece cuando las dos cifras están
          en la misma base: seis kilos crudos menos tres coma ocho cocidos no es
          un número que exista, y con ese número se decide si se prende otra
          tanda.

          Los dos valores los escribe la pantalla de cocina cuando se registra
          lo que sale de la parrilla. Mientras no haya registros, esto dice que
          no sabe — no dice cero.
        */}
        <ContadorVivo preparado={null} servido={servido} />
      </Section>

      <p className="flex flex-wrap gap-md font-body-sm text-body-sm text-outline">
        <Link href={`/eventos/${eventoId}`} className="underline">
          Volver al evento
        </Link>
        <Link href={`/eventos/${eventoId}/resumen`} className="underline">
          Ver el resumen
        </Link>
      </p>
    </div>
  );
}

/**
 * Las tandas: exactas, un rango, o el motivo por el que no se saben.
 *
 * Que sean un RANGO no es un defecto: mientras no haya un plan aceptado, cuánta
 * carne se pone en la parrilla depende de cuánto se compre, y decir "4 tandas"
 * a secas sería inventar la compra.
 */
function textoTandas(batches: BbqBatches): string {
  if (!batches.known) return `${SIN_INFORMACION} — ${TEXTO_MOTIVO[batches.reason]}`;
  if (batches.kind === "EXACT") {
    return `${batches.batches} ${batches.batches === 1 ? "tanda" : "tandas"}`;
  }
  return `entre ${batches.min} y ${batches.max} tandas`;
}

function BotonGrande({
  children,
  activo,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  activo: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={activo}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex min-h-[48px] items-center rounded-full px-lg font-body-md text-body-md font-semibold transition-transform active:scale-95 disabled:opacity-40 ${
        activo
          ? "bg-primary text-on-primary"
          : "border border-outline bg-surface-container-lowest text-on-surface-variant"
      }`}
    >
      {children}
    </button>
  );
}

/** El contador de "cuánto queda", con la regla de las bases. */
export function ContadorVivo({
  preparado,
  servido,
}: {
  preparado: { gramos: number; base: BaseFisica } | null;
  servido: { gramos: number; base: BaseFisica } | null;
}) {
  if (servido === null) {
    return (
      <Card className="p-md">
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          {SIN_INFORMACION}: todavía no hay registro de lo que salió de la parrilla.
        </p>
      </Card>
    );
  }

  if (preparado === null) {
    // Se sabe lo que salió a la mesa y NO cuánto se puso a cocinar. La resta no
    // existe, así que no se muestra: se muestra el número que sí es cierto y se
    // dice qué falta para poder restar.
    return (
      <Card className="space-y-sm p-md">
        <p className="font-body-md text-body-md text-on-surface">
          Servido: {formatearGramos(servido.gramos)} {ETIQUETA_BASE[servido.base]}
        </p>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Cuánto queda depende de cuánto pusiste a cocinar, y eso no está anotado.
        </p>
      </Card>
    );
  }

  const contador = contadorDelDia({ preparado, servido });

  if (contador.estado === "BASES_DISTINTAS") {
    return (
      <Card className="space-y-sm p-md">
        <p className="font-body-md text-body-md text-on-surface">
          Preparado: {formatearGramos(contador.preparadoG)} {ETIQUETA_BASE[contador.basePreparado]}
        </p>
        <p className="font-body-md text-body-md text-on-surface">
          Servido: {formatearGramos(contador.servidoG)} {ETIQUETA_BASE[contador.baseServido]}
        </p>
        <Notice icon="info">{contador.aviso}</Notice>
      </Card>
    );
  }

  return (
    <Card className="space-y-sm p-md">
      <p className="font-body-sm text-body-sm text-on-surface-variant">
        Todo en {ETIQUETA_BASE[contador.base]}
      </p>
      <p className="font-body-md text-body-md text-on-surface">
        Preparado: {formatearGramos(contador.preparadoG)}
      </p>
      <p className="font-body-md text-body-md text-on-surface">
        Servido: {formatearGramos(contador.servidoG)}
      </p>
      <p className="font-headline-sm text-headline-sm text-on-surface">
        <Icon name="restaurant" className="text-[20px]" /> Queda {formatearGramos(contador.quedaG)}
      </p>
    </Card>
  );
}
