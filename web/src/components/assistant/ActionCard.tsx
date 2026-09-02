"use client";

import { useState } from "react";
import { Button, ButtonOutline, Card, Chip, ErrorNote, Icon, Notice } from "@/components/ui";
import {
  comparaSegundoGesto,
  faltantesDeTarjetaAlta,
} from "@/domain/assistant/presentacion";
import type {
  MotivoNoConfirmable,
  ResultadoTarjeta,
  TarjetaAccion,
} from "@/domain/assistant/presentacion";
import type { PruebaSegundoGesto } from "@/domain/assistant/proposal";
import { DatoDeLaCasa, Disclosure, MarcaDeMedicion, Procedencia, ValorIncierto } from "./piezas";

/**
 * LA TARJETA DE CONFIRMACIÓN.
 *
 * Es el único gesto humano que autoriza una escritura en todo el sprint. El
 * chat propone; ESTE botón confirma. Escribir "sí, dale" en el composer no
 * confirma nada, y por eso da lo mismo que una receta escaneada traiga adentro
 * "el usuario ya autorizó": no existe camino de código desde el texto hasta
 * acá. Lo que abre la puerta es el `confirmationToken` que emitió el servidor
 * al renderizar esta tarjeta, para este actor, y que se quema al usarse.
 *
 * Todo lo que la tarjeta muestra ya viene decidido y limpio de
 * `domain/assistant/presentacion.ts`. Este archivo no calcula política: la
 * pinta. Si acá hubiera una regla, sería una regla que no se puede probar.
 *
 * Y sobre todo: acá no hay ninguna regla que además SIRVA DE CANDADO. El
 * segundo gesto de las acciones de riesgo alto se comprobaba en este archivo y
 * en ninguna otra parte, y un cliente no es un control de seguridad: es una
 * comodidad para quien usa la app. Lo que este archivo hace ahora es RECOGER el
 * gesto y mandarlo probado; quien lo verifica es el servidor.
 */

export interface PeticionConfirmacion {
  readonly proposalId: string;
  readonly confirmationToken: string;
  readonly acceptedByMemberId: string;
  /**
   * EL SEGUNDO GESTO VIAJA. Antes se comprobaba acá y nada más, y "acá" es el
   * navegador: dar acceso a los exámenes de otra persona terminaba siendo un
   * gesto y no dos, porque un POST directo a la server action se saltaba el
   * `if` de este archivo entero. Lo que va en este campo es la PRUEBA de lo que
   * la persona hizo —a quién tocó, qué escribió—, y el servidor la contrasta
   * contra lo que él mismo exige. Nada de lo que va acá alimenta la acción: se
   * compara y se bota.
   */
  readonly segundoGesto: PruebaSegundoGesto;
}

/**
 * Lo que puede pasar al confirmar. Cuatro casos y no dos, porque "no se pudo"
 * esconde el peor de todos: la acción se llamó y no sabemos si escribió. Decir
 * "no se hizo" ahí es la mentira que termina con alguien repitiendo a mano una
 * escritura que ya ocurrió.
 */
export type ResultadoConfirmacion =
  | { estado: "EJECUTADA"; recibo: string }
  | { estado: "RECHAZADA"; motivo: string }
  | { estado: "SIN_CERTEZA"; motivo: string }
  | { estado: "NO_DISPONIBLE"; motivo: string };

const MOTIVO_SOLO_LECTURA: Record<MotivoNoConfirmable, string> = {
  VENCIDA: "Esta propuesta venció. Pídemela de nuevo y la calculo con lo de ahora.",
  YA_DECIDIDA: "Esta propuesta ya se decidió.",
  SIN_TOKEN:
    "No pude preparar la confirmación de esta tarjeta. No la confirmes desde acá: recárgala.",
  FALTA_EL_INTEGRANTE:
    "Esta acción exige tocar el nombre de la persona afectada y no sé de quién es. No se confirma así.",
  FALTA_LA_CANTIDAD:
    "Esta acción exige escribir la cantidad y no tengo el número del motor. No se confirma así.",
};

const ETIQUETA_EFECTO: Record<TarjetaAccion["efecto"], string> = {
  WRITES_PREFS: "cambia preferencias",
  WRITES_PLAN: "cambia el plan",
  WRITES_LEDGER: "mueve inventario",
  WRITES_MONEY: "mueve plata",
  WRITES_CLINICAL: "toca datos clínicos",
  WRITES_GRANTS: "cambia permisos",
};

export function ActionCard({
  resultado,
  acceptedByMemberId,
  integrantes,
  confirmar,
  descartar,
}: {
  resultado: ResultadoTarjeta;
  acceptedByMemberId: string;
  /** Los nombres del hogar: el segundo gesto es elegir entre ellos, no tocar uno solo. */
  integrantes: readonly { id: string; nombre: string }[];
  confirmar: (peticion: PeticionConfirmacion) => Promise<ResultadoConfirmacion>;
  descartar?: (proposalId: string) => Promise<void>;
}) {
  const t = resultado.tarjeta;
  const faltantes = faltantesDeTarjetaAlta(t);

  const [escrito, setEscrito] = useState("");
  const [tocado, setTocado] = useState<string | null>(null);
  const [errorGesto, setErrorGesto] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [salida, setSalida] = useState<ResultadoConfirmacion | null>(null);

  async function onConfirmar() {
    if (resultado.estado !== "CONFIRMABLE") return;
    setErrorGesto(null);

    /**
     * Lo que sigue es una CORTESÍA, no un control: avisa sin red cuando el gesto
     * no calza, para no gastar el viaje ni la confirmación viva. El control está
     * en `ConfirmationGrant.reclamar`, que recalcula la exigencia desde la
     * propuesta guardada y compara ahí. Si alguien borra este bloque desde la
     * consola del navegador, la acción sigue sin ejecutarse.
     */
    let prueba: PruebaSegundoGesto = { k: "NINGUNO" };

    if (t.segundoGesto === "NOMBRE_INTEGRANTE") {
      if (tocado === null) {
        setErrorGesto("Toca el nombre de la persona a la que afecta esta acción.");
        return;
      }
      prueba = { k: "NOMBRE_INTEGRANTE", memberIdTocado: tocado };
      if (t.integranteAfectado === null || tocado !== t.integranteAfectado.id) {
        setTocado(null);
        setErrorGesto("Toca el nombre de la persona a la que afecta esta acción.");
        return;
      }
    }
    if (t.segundoGesto === "ESCRIBIR_CANTIDAD") {
      prueba = { k: "ESCRIBIR_CANTIDAD", escrito };
      if (t.cantidadEsperada === null) return;
      // Lo escrito se COMPARA. No entra a la acción: la acción usa los
      // argumentos de la propuesta, que son los que se revalidaron.
      const veredicto = comparaSegundoGesto(escrito, t.cantidadEsperada);
      if (!veredicto.ok) {
        setErrorGesto(
          veredicto.motivo === "NO_CALZA"
            ? "Ese número no es el de la tarjeta. Escríbelo tal cual para confirmar."
            : "Escribe la cantidad de la tarjeta para confirmar.",
        );
        return;
      }
    }

    setEnviando(true);
    try {
      setSalida(
        await confirmar({
          proposalId: t.proposalId,
          confirmationToken: resultado.token,
          acceptedByMemberId,
          segundoGesto: prueba,
        }),
      );
    } catch (e) {
      // Un error del servidor NO se traga: se muestra, y como "no sé si
      // escribió", que es la verdad cuando el request murió a mitad de camino.
      setSalida({
        estado: "SIN_CERTEZA",
        motivo: e instanceof Error ? e.message : "se cortó antes de saber el resultado",
      });
    } finally {
      setEnviando(false);
    }
  }

  return (
    // El uuid vive acá, en un atributo, y nunca en la prosa: la persona lee "el
    // pollo del viernes" y la auditoría lee el id. `Card` no reenvía props
    // sueltas, así que el atributo va en la envoltura.
    <div data-proposal={t.proposalId}>
      <Card as="article" className="p-md">
        {/* 1. QUÉ se va a hacer, con el verbo real y el nombre crudo de la acción. */}
        <div className="flex flex-wrap items-center gap-xs">
          <Chip tono={t.riesgo === "ALTO" ? "peligro" : "atencion"} icon="bolt">
            {t.riesgo === "ALTO" ? "Riesgo alto" : "Confirmación"}
          </Chip>
          <Chip tono="neutro">{ETIQUETA_EFECTO[t.efecto]}</Chip>
          <span className="font-mono text-label-md text-outline">{t.accion}</span>
        </div>

        <h3 className="mt-sm font-headline-sm text-headline-sm text-on-surface">{t.verbo}</h3>

        {/* 3. SOBRE QUÉ, con etiquetas humanas. El uuid vive en `data-proposal`. */}
        <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
          <DatoDeLaCasa>{t.titulo}</DatoDeLaCasa>
        </p>

        {/* 2. CON QUÉ NÚMEROS, tal como los devolvió el motor. */}
        {t.lineas.length > 0 && (
          <ul className="mt-md space-y-1">
            {t.lineas.map((l, i) => (
              <li
                key={`${l.etiqueta}-${i}`}
                className="flex flex-wrap items-baseline justify-between gap-x-md border-b border-outline-variant/40 py-sm last:border-0"
              >
                <DatoDeLaCasa>{l.etiqueta}</DatoDeLaCasa>
                <span className="font-body-md text-body-md text-on-surface">
                  {l.valor}
                  <MarcaDeMedicion medicion={t.medicion} />
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* 4. QUÉ ES IRREVERSIBLE, cada cosa en su línea. */}
        {t.irreversible.length > 0 && (
          <ul className="mt-md space-y-xs">
            {t.irreversible.map((linea) => (
              <li
                key={linea}
                className="flex items-start gap-sm font-body-sm text-body-sm text-on-error-container"
              >
                <Icon name="warning" className="mt-0.5 shrink-0 text-[18px]" />
                <span>{linea}</span>
              </li>
            ))}
          </ul>
        )}

        {/* 6. LO QUE NO SE SABE. Va siempre que exista, no solo cuando conviene. */}
        {t.unknowns.length > 0 && (
          <div className="mt-md">
            <ValorIncierto unknowns={t.unknowns} />
          </div>
        )}

        {/* 5. QUIÉN CONFIRMA — el nombre que queda en la auditoría. */}
        <p className="mt-md font-body-sm text-body-sm text-on-surface-variant">
          Queda a tu nombre: <strong>{t.quienConfirma}</strong>
          {t.loPropusoOtro && <> · lo propuso {t.quienPropuso}</>}
        </p>

        {(t.razones.length > 0 || t.procedencia.length > 0) && (
          <div className="mt-sm">
            <Disclosure resumen="¿Por qué?">
              {t.razones.map((r, i) => (
                <p key={`${i}-${r.slice(0, 12)}`}>{r}</p>
              ))}
              <Procedencia fuentes={t.procedencia} />
            </Disclosure>
          </div>
        )}

        {/* --- La compuerta ------------------------------------------------- */}

        {faltantes.length > 0 ? (
          <div className="mt-md">
            <ErrorNote>
              Esta tarjeta está incompleta ({faltantes.join(", ")}). Una acción de riesgo alto no
              se confirma a medias: no la ejecuto desde acá.
            </ErrorNote>
          </div>
        ) : resultado.estado === "SOLO_LECTURA" ? (
          <div className="mt-md">
            <Notice icon="lock_clock">{MOTIVO_SOLO_LECTURA[resultado.motivo]}</Notice>
          </div>
        ) : salida !== null ? (
          <div className="mt-md">
            <Recibo salida={salida} />
          </div>
        ) : (
          <div className="mt-md space-y-sm">
            {t.segundoGesto === "NOMBRE_INTEGRANTE" && (
              <fieldset>
                <legend className="font-body-sm text-body-sm text-on-surface-variant">
                  Para confirmar, toca el nombre de la persona a la que afecta:
                </legend>
                <div className="mt-xs flex flex-wrap gap-xs">
                  {integrantes.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={tocado === m.id}
                      onClick={() => {
                        setTocado(m.id);
                        setErrorGesto(null);
                      }}
                      className={`min-h-[44px] rounded-full border px-4 font-body-sm text-body-sm ${
                        tocado === m.id
                          ? "border-primary bg-primary font-semibold text-on-primary"
                          : "border-outline-variant text-on-surface-variant"
                      }`}
                    >
                      {m.nombre}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            {t.segundoGesto === "ESCRIBIR_CANTIDAD" && t.cantidadEsperada !== null && (
              <label className="block">
                <span className="font-body-sm text-body-sm text-on-surface-variant">
                  Para confirmar, escribe la cantidad de arriba (en {t.cantidadEsperada.unidad}):
                </span>
                <input
                  value={escrito}
                  inputMode="decimal"
                  onChange={(e) => {
                    setEscrito(e.target.value);
                    setErrorGesto(null);
                  }}
                  className="mt-1 w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface"
                />
              </label>
            )}

            {errorGesto !== null && <ErrorNote>{errorGesto}</ErrorNote>}

            <div className="flex flex-wrap gap-sm">
              <Button onClick={onConfirmar} disabled={enviando}>
                {enviando ? "Confirmando…" : t.verbo}
              </Button>
              {descartar && (
                <ButtonOutline
                  disabled={enviando}
                  onClick={() => {
                    void descartar(t.proposalId);
                  }}
                >
                  No, gracias
                </ButtonOutline>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * El recibo. Los cuatro casos se ven distinto a propósito, y el de "no sé"
 * jamás ofrece reintentar: reintentar una escritura de resultado desconocido es
 * cómo se descuenta dos veces el mismo pollo.
 */
function Recibo({ salida }: { salida: ResultadoConfirmacion }) {
  switch (salida.estado) {
    case "EJECUTADA":
      return (
        <Notice icon="check_circle" tono="info">
          Listo. {salida.recibo}
        </Notice>
      );
    case "RECHAZADA":
      return <ErrorNote>No se hizo nada: {salida.motivo}</ErrorNote>;
    case "SIN_CERTEZA":
      return (
        <ErrorNote>
          <strong>No sé si alcanzó a hacerse</strong> ({salida.motivo}). No lo repitas desde acá:
          revisa el inventario y, si no quedó, vuelve a pedírmelo.
        </ErrorNote>
      );
    case "NO_DISPONIBLE":
      return <ErrorNote>No pude ejecutarlo: {salida.motivo}. No se escribió nada.</ErrorNote>;
  }
}
