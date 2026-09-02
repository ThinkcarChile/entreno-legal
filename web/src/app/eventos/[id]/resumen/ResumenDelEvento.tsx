"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Card, CAMPO, Chip, ErrorNote, Flotante, Notice, Section } from "@/components/ui";
import type { ResumenEvento } from "@/domain/events/learning/resumen";
import {
  declararMiPorcionDelEvento,
  observarComensal,
  registrarBalance,
  type ResultadoAccion,
} from "../../servicio-actions";
import type { ObservacionComensal, RenglonServido } from "../../servicio-queries";
import type { Participante } from "../../queries";
import { formatearGramos, personas } from "../../formato";
import { SIN_INFORMACION } from "../../vocabulario";

/**
 * La escala del Sprint 12 (`intake_extent`), con las palabras con que una
 * persona describe su plato. No hay gramos acá a propósito: la cantidad va sin
 * declarar y el motor adaptativo la recibe con su confianza propia (§60).
 */
const ETIQUETA_PORCION: Record<string, string> = {
  ALL: "Comí todo",
  MOST: "Casi todo",
  HALF: "La mitad",
  LITTLE: "Poco",
  NONE: "Nada",
};

const ETIQUETA_EXTENSION: Record<string, string> = {
  ATE_LITTLE: "Comió poco",
  ATE_NORMAL: "Comió normal",
  ATE_A_LOT: "Comió harto",
};

/**
 * RESUMEN DEL ASADO (§56).
 *
 * Es una LECTURA de tres hechos que ya existen —lo servido por el libro mayor,
 * lo que volvió como lote y lo que alguien declaró— y de ninguno que no exista.
 * Por eso hay tantos "no se sabe" a la vista: cada uno es un lugar donde la
 * alternativa habría sido inventar un número que después alimenta el
 * aprendizaje de todos los asados siguientes.
 */
export function ResumenDelEvento({
  eventoId,
  fechaDelEvento,
  resumen,
  servido,
  participantes,
  observaciones,
  puedeEditar,
}: {
  eventoId: string;
  fechaDelEvento: string;
  resumen: ResumenEvento;
  servido: RenglonServido[];
  participantes: Participante[];
  observaciones: Record<string, ObservacionComensal>;
  puedeEditar: boolean;
}) {
  const [pendiente, empezar] = useTransition();
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function correr(accion: () => Promise<ResultadoAccion>) {
    setError(null);
    setMensaje(null);
    empezar(async () => {
      const r = await accion();
      if (!r.ok) {
        setError(r.error ?? "No se pudo guardar.");
        return;
      }
      setMensaje(r.message ?? "Listo.");
    });
  }

  return (
    <div className="space-y-lg">
      {mensaje && <Flotante tono="ok">{mensaje}</Flotante>}
      {error && <ErrorNote>{error}</ErrorNote>}

      <Section title="Quiénes fueron">
        <Card className="p-md">
          {resumen.asistencia.cobertura === "COMPLETA" ? (
            <>
              <p className="font-headline-md text-headline-md text-on-surface">
                {personas(resumen.asistencia.asistieron)} asistieron
              </p>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {resumen.asistencia.noLlegaron} no llegaron, de{" "}
                {personas(resumen.asistencia.esperados)} confirmadas.
                {resumen.asistencia.extras > 0 &&
                  ` Además llegaron ${resumen.asistencia.extras} que no estaban en la lista.`}
              </p>
            </>
          ) : resumen.asistencia.cobertura === "PARCIAL" ? (
            <>
              <p className="font-headline-md text-headline-md text-on-surface">
                Llegaron al menos {personas(resumen.asistencia.asistieron)}
              </p>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                La lista quedó a medias: {personas(resumen.asistencia.sinMarcar)} confirmadas
                nunca se marcaron, así que de esas no sabemos si llegaron. No son ausentes.
                {resumen.asistencia.extras > 0 &&
                  ` Además llegaron ${resumen.asistencia.extras} que no estaban en la lista.`}
              </p>
            </>
          ) : (
            <>
              <p className="font-headline-md text-headline-md text-on-surface">
                Asistencia no registrada
              </p>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                Nadie pasó lista, así que contamos {personas(resumen.asistencia.esperados)}{" "}
                confirmadas — que es una estimación, no un conteo. No quiere decir que no haya
                llegado nadie.
              </p>
            </>
          )}
        </Card>
      </Section>

      <Section title="La comida, corte por corte" hint="Lo que no se midió aparece como tal.">
        <ul className="space-y-sm">
          {resumen.lineas.map((l) => (
            <li key={l.ref}>
              <Card className="space-y-sm p-md">
                <p className="font-body-md text-body-md font-semibold text-on-surface">{l.label}</p>

                <Dato
                  rotulo="Salió a la mesa"
                  valor={l.servedG === null ? null : `${formatearGramos(l.servedG)} cocidos`}
                />
                <Dato
                  rotulo="Se estima consumido"
                  valor={l.consumedG === null ? null : formatearGramos(l.consumedG)}
                  ayuda={
                    l.consumedG === null
                      ? "Nadie anotó si sobró o se botó algo, así que no se puede decir cuánto se comieron."
                      : null
                  }
                />
                <Dato
                  rotulo="Sobra utilizable"
                  valor={
                    l.edibleLeftoverG === null ? null : formatearGramos(l.edibleLeftoverG)
                  }
                />
                {/*
                  Hueso y desgrase van SEPARADOS y cada uno con su propio "no se
                  sabe". Sumarlos con un cero por el que falta mostraría "500 g
                  de hueso y desgrase" cuando el desgrase no lo pesó nadie: el
                  número quedaría bien y el rótulo mintiendo.
                */}
                <Dato
                  rotulo="Hueso"
                  valor={l.boneDiscardG === null ? null : formatearGramos(l.boneDiscardG)}
                />
                <Dato
                  rotulo="Desgrase y limpieza"
                  valor={l.trimWasteG === null ? null : formatearGramos(l.trimWasteG)}
                  ayuda="Ninguno de los dos es sobra de comida: salen del peso crudo, no de lo que llegó al plato."
                />
                {l.rawInputG !== null && (
                  <p className="font-body-sm text-body-sm text-outline">
                    Entraron {formatearGramos(l.rawInputG)} crudos. No se resta de lo servido: son
                    pesos de estados distintos y la diferencia es, sobre todo, agua.
                  </p>
                )}
                {l.sinRespaldoG !== null && l.sinRespaldoG > 0 && (
                  <Notice icon="help">
                    {formatearGramos(l.sinRespaldoG)} de lo servido no salieron de un lote
                    registrado.
                  </Notice>
                )}
              </Card>
            </li>
          ))}
        </ul>
        {resumen.lineas.length === 0 && (
          <Card className="p-md">
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              No se anotó nada de lo que salió a la mesa en este evento.
            </p>
          </Card>
        )}
      </Section>

      {puedeEditar && servido.length > 0 && (
        <Section
          title="Completar el balance"
          hint="Sólo lo que hayas medido de verdad. Lo que no, se deja en blanco."
        >
          <ul className="space-y-sm">
            {servido.map((r) => (
              <li key={r.id}>
                <FormularioBalance
                  eventoId={eventoId}
                  etiqueta={r.label}
                  itemMenuId={r.itemMenuId}
                  servido={r.cantidad}
                  pendiente={pendiente}
                  onCorrer={correr}
                />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="¿Cuánto comió cada uno?"
        hint="Opcional y a ojo. Es el único dato del que salen las sugerencias de apetito."
      >
        <Card className="mb-sm p-md">
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Esto NO se calcula repartiendo el total entre los asistentes: ese número no sería de
            nadie. Si no lo anotas, la app no va a sugerir cambiarle el apetito a nadie — y está
            bien que no lo haga.
          </p>
        </Card>
        <ul className="space-y-sm">
          {participantes.map((p) => {
            const obs = observaciones[p.id];
            return (
              <li key={p.id}>
                <Card className="flex flex-wrap items-center justify-between gap-sm p-md">
                  <span className="font-body-md text-body-md text-on-surface">
                    {p.nombre ?? "Invitado sin nombre"}
                  </span>
                  <span className="flex flex-wrap items-center gap-sm">
                    {obs === undefined ? (
                      <Chip>{SIN_INFORMACION}</Chip>
                    ) : (
                      <Chip>
                        {obs.extension === null
                          ? `${SIN_INFORMACION} (${obs.extensionCruda})`
                          : ETIQUETA_EXTENSION[obs.extension]}
                      </Chip>
                    )}
                    {puedeEditar &&
                      (["ATE_LITTLE", "ATE_NORMAL", "ATE_A_LOT"] as const).map((ext) => (
                        <button
                          key={ext}
                          type="button"
                          disabled={pendiente}
                          aria-pressed={obs?.extension === ext}
                          onClick={() =>
                            correr(() =>
                              observarComensal({
                                eventoId,
                                participanteId: p.id,
                                extension: ext,
                                nota: null,
                              }),
                            )
                          }
                          className={`inline-flex min-h-[44px] items-center rounded-full px-md font-body-sm text-body-sm transition-transform active:scale-95 disabled:opacity-40 ${
                            obs?.extension === ext
                              ? "bg-primary text-on-primary"
                              : "border border-outline bg-surface-container-lowest text-on-surface-variant"
                          }`}
                        >
                          {ETIQUETA_EXTENSION[ext]}
                        </button>
                      ))}
                  </span>
                </Card>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title="Anotar mi porción"
        hint="Sólo para quien lleva su registro de comidas. Nadie está obligado."
      >
        <Card className="mb-sm p-md">
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Esto va a tu registro de comidas como una DECLARACIÓN, sin cantidad exacta: nadie pesó
            su plato en el asado. No vuelve a descontar comida de la despensa — eso ya pasó una
            vez, cuando la fuente salió a la mesa.
          </p>
        </Card>
        <ul className="space-y-sm">
          {participantes
            .filter((p) => p.tipo === "HOUSEHOLD_MEMBER" && p.memberId !== null)
            .map((p) => (
              <li key={p.id}>
                <Card className="flex flex-wrap items-center justify-between gap-sm p-md">
                  <span className="font-body-md text-body-md text-on-surface">
                    {p.nombre ?? "Integrante"}
                  </span>
                  <span className="flex flex-wrap items-center gap-sm">
                    {(["ALL", "MOST", "HALF", "LITTLE", "NONE"] as const).map((ext) => (
                      <button
                        key={ext}
                        type="button"
                        disabled={pendiente}
                        onClick={() =>
                          correr(() =>
                            declararMiPorcionDelEvento({
                              eventoId,
                              memberId: p.memberId,
                              etiqueta: "Comida del evento",
                              extension: ext,
                              fecha: fechaDelEvento,
                            }),
                          )
                        }
                        className="inline-flex min-h-[44px] items-center rounded-full border border-outline bg-surface-container-lowest px-md font-body-sm text-body-sm text-on-surface-variant transition-transform active:scale-95 disabled:opacity-40"
                      >
                        {ETIQUETA_PORCION[ext]}
                      </button>
                    ))}
                  </span>
                </Card>
              </li>
            ))}
        </ul>
      </Section>

      <p className="font-body-sm text-body-sm text-outline">
        <Link href={`/eventos/${eventoId}`} className="underline">
          Volver al evento
        </Link>
      </p>
    </div>
  );
}

function Dato({
  rotulo,
  valor,
  ayuda,
}: {
  rotulo: string;
  valor: string | null;
  ayuda?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-sm">
      <span className="font-body-sm text-body-sm text-on-surface-variant">{rotulo}</span>
      <span className="font-body-md text-body-md text-on-surface">
        {valor === null ? SIN_INFORMACION : valor}
      </span>
      {typeof ayuda === "string" && ayuda.length > 0 && (
        <span className="w-full font-body-sm text-body-sm text-outline">{ayuda}</span>
      )}
    </div>
  );
}

/**
 * El formulario del balance: cada casilla puede quedar VACÍA.
 *
 * Vacío se manda como `null` y se guarda como `null`. Un cero significa "medí y
 * no había"; el vacío, "nadie midió". Poner 0 por omisión sería declarar en
 * nombre del usuario que no sobró nada.
 */
function FormularioBalance({
  eventoId,
  etiqueta,
  itemMenuId,
  servido,
  pendiente,
  onCorrer,
}: {
  eventoId: string;
  etiqueta: string;
  itemMenuId: string | null;
  servido: number;
  pendiente: boolean;
  onCorrer: (accion: () => Promise<ResultadoAccion>) => void;
}) {
  const [crudo, setCrudo] = useState("");
  const [sobra, setSobra] = useState("");
  const [plato, setPlato] = useState("");
  const [hueso, setHueso] = useState("");

  const numero = (texto: string): number | null => {
    const limpio = texto.trim().replace(",", ".");
    if (limpio.length === 0) return null;
    const n = Number(limpio);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  return (
    <Card className="space-y-sm p-md">
      <p className="font-body-md text-body-md font-semibold text-on-surface">{etiqueta}</p>
      <p className="font-body-sm text-body-sm text-outline">
        Salieron {formatearGramos(servido)} a la mesa.
      </p>
      <div className="grid grid-cols-2 gap-sm">
        <Campo rotulo="Crudo que entró" valor={crudo} onChange={setCrudo} />
        <Campo rotulo="Sobra utilizable" valor={sobra} onChange={setSobra} />
        <Campo rotulo="Quedó en los platos" valor={plato} onChange={setPlato} />
        <Campo rotulo="Hueso / desgrase" valor={hueso} onChange={setHueso} />
      </div>
      <button
        type="button"
        disabled={pendiente}
        className="min-h-[44px] font-body-sm text-body-sm text-primary underline disabled:opacity-40"
        onClick={() =>
          onCorrer(() =>
            registrarBalance({
              eventoId,
              itemMenuId,
              etiqueta,
              crudoQueEntro: numero(crudo),
              servido,
              sobraComestible: numero(sobra),
              mermaDePlato: numero(plato),
              mermaDeLimpieza: null,
              hueso: numero(hueso),
              echadoAPerder: null,
            }),
          )
        }
      >
        Guardar este balance
      </button>
    </Card>
  );
}

function Campo({
  rotulo,
  valor,
  onChange,
}: {
  rotulo: string;
  valor: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="font-body-sm text-body-sm text-on-surface-variant">{rotulo}</span>
      <input
        className={CAMPO}
        inputMode="decimal"
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        placeholder="en blanco = no se midió"
      />
    </label>
  );
}
