"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Button,
  ButtonOutline,
  CAMPO,
  Card,
  Chip,
  DataRow,
  EmptyState,
  ErrorNote,
  Flotante,
  Icon,
  LinkButton,
  Notice,
  Section,
  TextField,
  ToggleChip,
} from "@/components/ui";
import {
  agregarComidaCubierta,
  agregarInvitadoExistente,
  agregarItemMenu,
  agregarMiembro,
  ajustarApetito,
  borrarBorrador,
  calcularEstimacion,
  cambiarEstado,
  guardarConfiguracion,
  guardarDistribucion,
  quitarComidaCubierta,
  quitarItemMenu,
  quitarParticipante,
  type ResultadoAccion,
} from "../actions";
import type { ComidaCubierta, Evento, Invitado, ItemMenu, Participante } from "../queries";
import type { Revision } from "../contrato-estimacion";
import {
  formatearRango,
  personas,
  resumenAsistencia,
  textoRestricciones,
  TEXTO_CONFIANZA,
  TONO_CONFIANZA,
} from "../formato";
import {
  APETITOS,
  CATEGORIAS_MENU,
  CONTEXTOS_COMIDA,
  ETIQUETA_ACOMPANAMIENTO,
  ETIQUETA_APETITO,
  ETIQUETA_ASISTENCIA,
  ETIQUETA_BANDERA,
  ETIQUETA_CATEGORIA,
  ETIQUETA_CONTEXTO,
  ETIQUETA_EDAD,
  ETIQUETA_ESTADO,
  ETIQUETA_SOBRANTE,
  NIVELES_ACOMPANAMIENTO,
  SIN_INFORMACION,
  SOBRANTES_DESEADOS,
  type CategoriaMenu,
} from "../vocabulario";
import { MEAL_TYPES, MEAL_TYPE_LABELS } from "@/domain/recipes/types";
import { textoDelRelevo, type RelevoDeEvento } from "@/app/demanda-abierta";
import { InvitadoRapido } from "./InvitadoRapido";

/**
 * El tablero del evento: ANTES, HOY y DESPUÉS.
 *
 * Dos reglas mandan sobre todo lo que se dibuja acá:
 *
 *  · NADA CLÍNICO. Esta pantalla está abierta sobre la mesa mientras se cocina
 *    y la miran los invitados. No muestra diagnósticos, ni límites, ni labs, ni
 *    de los integrantes del hogar ni de nadie. De los invitados solo se ve la
 *    bandera culinaria que ellos mismos reportaron.
 *
 *  · LO QUE NO SE SABE SE DICE. Un invitado sin restricciones declaradas sale
 *    como "Sin información", jamás como "sin restricciones", y la sección lleva
 *    la cuenta de cuántos están así para que se pueda preguntar antes de
 *    comprar.
 */

interface Miembro {
  id: string;
  nombre: string;
}

export function TableroEvento({
  evento,
  hoy,
  householdId,
  participantes,
  menu,
  invitadosDelHogar,
  miembros,
  revision,
  relevos,
  comidasCubiertas,
}: {
  evento: Evento;
  hoy: string;
  householdId: string;
  participantes: Participante[];
  menu: ItemMenu[];
  invitadosDelHogar: Invitado[];
  miembros: Miembro[];
  revision: Revision | null;
  /**
   * Lo que este evento releva HOY, leído de la base. Vacío no es "no releva
   * nada por diseño": puede ser que falte declarar la comida, que el evento no
   * esté confirmado o que no haya nadie del hogar en el roster. La pantalla
   * distingue los casos en vez de mostrar un silencio que se lee como "listo".
   */
  relevos: RelevoDeEvento[];
  /**
   * TODAS las comidas del plan que el evento reemplaza (0061). Llega aparte y
   * no dentro de `evento` porque `evento.comida` es sólo la PRIMERA: dibujar el
   * selector con ese campo mostraría el asado de almuerzo y cena como si
   * cubriera sólo el almuerzo, y la persona marcaría la cena de nuevo sin que
   * pase nada visible.
   */
  comidasCubiertas: ComidaCubierta[];
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
        setError(r.error ?? "No se pudo completar la acción.");
        return;
      }
      setMensaje(r.message ?? "Listo.");
      router.refresh();
    });
  }

  const carnes = menu.filter((i) => i.tipo === "MEAT");
  const acompanamientos = menu.filter((i) => i.tipo === "SIDE");
  const bebidas = menu.filter((i) => i.tipo === "BEVERAGE");
  const noComestibles = menu.filter((i) => i.tipo === "NON_FOOD");
  // Items guardados con una clase que esta versión no conoce. No se esconden ni
  // se meten en otra lista: se muestran aparte, con su código, porque hasta que
  // se aclaren el cálculo no corre.
  const sinClasificar = menu.filter((i) => i.tipo === null);

  const yaEnEvento = new Set(participantes.map((p) => p.memberId ?? p.guestId));
  const miembrosDisponibles = miembros.filter((m) => !yaEnEvento.has(m.id));
  const invitadosDisponibles = invitadosDelHogar.filter((i) => !yaEnEvento.has(i.id));

  // SÓLO los invitados: de la familia la aplicación ya sabe, por ingrediente, y
  // el cálculo lo usa (ver `cargarBloqueosDelMenu`). Contarlos acá como "sin
  // información" era pedirle al anfitrión que preguntara por datos que la app
  // tiene guardados hace meses.
  const sinInfoDietaria = participantes.filter(
    (p) => p.tipo === "GUEST" && p.banderasDietarias === null,
  ).length;
  // A quién de la CASA le cambia el día este evento. Se mira acá porque es la
  // pantalla donde se arma la lista: un asado sin integrantes del hogar —o con
  // todos los del hogar diciendo que no van— NO le relaja los objetivos a
  // nadie, y eso hay que decirlo antes de que alguien lo descubra el sábado.
  const delHogar = participantes.filter((p) => p.tipo === "HOUSEHOLD_MEMBER");
  const delHogarQueVan = delHogar.filter(
    (p) => p.asistencia !== "DECLINED" && p.asistencia !== "NO_SHOW",
  );
  const asistencia = resumenAsistencia({
    llegaron: participantes.filter((p) => p.asistencia === "ATTENDED").length,
    noLlegaron: participantes.filter((p) => p.asistencia === "NO_SHOW").length,
    // Confirmados que TODAVÍA nadie marcó. Se cuentan aparte porque no son
    // ausentes: son gente que nadie miró, y meterlos en el mismo saco convertía
    // una lista a medias en un conteo cerrado.
    sinMarcar: participantes.filter((p) => p.asistencia === "CONFIRMED").length,
  });

  // Las comidas cubiertas, partidas en dos: las que esta versión sabe dibujar y
  // las que no. Una comida guardada con un código que la app no conoce NO se
  // esconde — esconderla mostraría menos cobertura de la que hay, y esa
  // diferencia es exactamente lo que alguien termina comprando de más.
  const cubiertas = new Set(
    comidasCubiertas.filter((c) => c.comida !== null).map((c) => c.comida as string),
  );
  const cubiertasDesconocidas = comidasCubiertas
    .filter((c) => c.comida === null)
    .map((c) => c.comidaCruda);

  const esHoy = evento.fecha === hoy;
  const yaPaso = evento.fecha < hoy;

  return (
    <div className="space-y-lg">
      {mensaje && <Flotante tono="ok">{mensaje}</Flotante>}
      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="p-md">
        <div className="flex flex-wrap items-center gap-sm">
          <Chip icon="event">{evento.fecha}</Chip>
          {evento.horaDeServir && <Chip icon="schedule">{evento.horaDeServir.slice(0, 5)}</Chip>}
          <Chip>{evento.estado ? ETIQUETA_ESTADO[evento.estado] : evento.estadoCrudo}</Chip>
          <Chip icon="group">{personas(participantes.length)}</Chip>
          {evento.bloqueadoEn !== null && <Chip icon="lock">Plan bloqueado</Chip>}
        </div>
        <div className="mt-md flex flex-wrap gap-sm">
          {evento.estado === "DRAFT" && (
            <Button
              disabled={pendiente}
              onClick={() => correr(() => cambiarEstado({ eventoId: evento.id, estado: "PLANNED" }))}
            >
              Dejarlo planificado
            </Button>
          )}
          {/*
            BORRAR sólo aparece en borrador, y es lo único de esta pantalla que
            destruye una fila. Después de "Dejarlo planificado" ya no está: desde
            ahí la salida es cancelar, que conserva todo. Quien lo aprieta con un
            borrador que ya pidió comida o ya sirvió recibe el mensaje de la base
            —"este evento ya dejó rastro (…): cancélalo, no lo borres"— entero,
            que es lo único que le dice qué hacer a continuación.
          */}
          {evento.estado === "DRAFT" && (
            <ButtonOutline
              disabled={pendiente}
              onClick={() =>
                empezar(async () => {
                  const r = await borrarBorrador({ eventoId: evento.id });
                  if (!r.ok) {
                    setError(r.error ?? "No se pudo borrar el borrador.");
                    return;
                  }
                  router.push("/eventos");
                })
              }
            >
              Borrar borrador
            </ButtonOutline>
          )}
          {(evento.estado === "PLANNED" || evento.estado === "CONFIRMED") && (
            <ButtonOutline
              disabled={pendiente}
              onClick={() =>
                correr(() => cambiarEstado({ eventoId: evento.id, estado: "CANCELLED" }))
              }
            >
              Cancelar evento
            </ButtonOutline>
          )}
          {esHoy && <LinkButton href={`/eventos/${evento.id}/dia`}>Modo día del evento</LinkButton>}
        </div>
      </Card>

      {evento.estado === "CANCELLED" && (
        <Notice icon="report">
          Este evento está cancelado. Lo que ya se compró SIGUE en la despensa: cancelar un evento
          no borra comida que existe.
        </Notice>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* ANTES                                                              */}
      {/* ------------------------------------------------------------------ */}

      <Section
        title="Quiénes vienen"
        hint="Los invitados no necesitan cuenta ni ficha completa."
        action={
          <InvitadoRapido
            eventoId={evento.id}
            householdId={householdId}
            esExtra={false}
            etiquetaBoton="Agregar invitado"
          />
        }
      >
        {delHogar.length === 0 && (
          <div className="mb-md">
            <Notice icon="info">
              Nadie de la casa está en la lista. Mientras siga así, este evento NO le cambia los
              objetivos del día a ningún integrante. Si van a comer acá, agrégalos.
            </Notice>
          </div>
        )}

        {delHogar.length > 0 && delHogarQueVan.length === 0 && (
          <div className="mb-md">
            <Notice icon="info">
              Los integrantes de la casa que estaban en la lista dijeron que no van, así que el
              evento no les cambia los objetivos del día. La comida de ese día les sigue
              corriendo igual.
            </Notice>
          </div>
        )}

        {sinInfoDietaria > 0 && (
          <div className="mb-md">
            <Notice icon="help">
              {sinInfoDietaria === 1
                ? "1 invitado sin información de restricciones."
                : `${sinInfoDietaria} invitados sin información de restricciones.`}{" "}
              No significa que no tengan: significa que nadie preguntó. Vale la pena preguntar antes
              de comprar.
            </Notice>
          </div>
        )}

        {participantes.length === 0 ? (
          <EmptyState icon="group_add">
            Todavía no hay nadie. Sin gente no hay para cuántos calcular.
          </EmptyState>
        ) : (
          <ul className="space-y-sm">
            {participantes.map((p) => (
              <li key={p.id}>
                <Card className="p-md">
                  <div className="flex flex-wrap items-start justify-between gap-sm">
                    <div className="min-w-0">
                      <p className="font-body-md text-body-md font-semibold text-on-surface">
                        {p.nombre ?? "Invitado sin nombre"}
                        {p.esExtra && " · llegó sin aviso"}
                      </p>
                      <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">
                        {ETIQUETA_EDAD[p.grupoEdad]} ·{" "}
                        {p.apetitoEfectivo === "UNKNOWN"
                          ? SIN_INFORMACION
                          : ETIQUETA_APETITO[p.apetitoEfectivo]}
                        {p.apetitoAjustado && " (solo para este evento)"}
                      </p>
                      {/* Tres estados posibles y los tres se dicen distinto. */}
                      <p className="mt-0.5 font-body-sm text-body-sm text-outline">
                        {textoRestricciones(p.banderasDietarias, ETIQUETA_BANDERA)}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-sm">
                      <Chip>
                        {p.asistencia ? ETIQUETA_ASISTENCIA[p.asistencia] : p.asistenciaCruda}
                      </Chip>
                      <button
                        type="button"
                        disabled={pendiente}
                        onClick={() =>
                          correr(() =>
                            quitarParticipante({ eventoId: evento.id, participanteId: p.id }),
                          )
                        }
                        className="font-body-sm text-body-sm font-semibold text-on-surface-variant underline disabled:opacity-40"
                      >
                        Quitar
                      </button>
                    </div>
                  </div>

                  <div className="mt-sm flex flex-wrap gap-sm">
                    {APETITOS.map((a) => (
                      <ToggleChip
                        key={a}
                        activo={p.apetitoAjustado && p.apetitoEfectivo === a}
                        disabled={pendiente}
                        title="Solo para este evento: no le cambia la ficha"
                        onClick={() =>
                          correr(() =>
                            ajustarApetito({
                              eventoId: evento.id,
                              participanteId: p.id,
                              apetito: p.apetitoAjustado && p.apetitoEfectivo === a ? null : a,
                            }),
                          )
                        }
                      >
                        {a === "UNKNOWN" ? SIN_INFORMACION : ETIQUETA_APETITO[a]}
                      </ToggleChip>
                    ))}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}

        {(miembrosDisponibles.length > 0 || invitadosDisponibles.length > 0) && (
          <Card className="mt-md space-y-sm p-md">
            <p className="font-body-sm text-body-sm text-on-surface-variant">Sumar a alguien</p>
            <div className="flex flex-wrap gap-sm">
              {miembrosDisponibles.map((m) => (
                <ButtonOutline
                  key={m.id}
                  disabled={pendiente}
                  onClick={() => correr(() => agregarMiembro({ eventoId: evento.id, memberId: m.id }))}
                >
                  {m.nombre}
                </ButtonOutline>
              ))}
              {invitadosDisponibles.map((i) => (
                <ButtonOutline
                  key={i.id}
                  disabled={pendiente}
                  onClick={() =>
                    correr(() => agregarInvitadoExistente({ eventoId: evento.id, guestId: i.id }))
                  }
                >
                  {i.nombre ?? "Invitado sin nombre"}
                </ButtonOutline>
              ))}
            </div>
          </Card>
        )}
      </Section>

      <Section title="Qué se come" hint="Primero el total de comida; después cómo se reparte.">
        <ListaMenu
          titulo="Carnes"
          items={carnes}
          vacio="Sin carnes todavía."
          pendiente={pendiente}
          onQuitar={(itemId) => correr(() => quitarItemMenu({ eventoId: evento.id, itemId }))}
        />
        <ListaMenu
          titulo="Acompañamientos"
          items={acompanamientos}
          vacio="Sin acompañamientos anotados."
          pendiente={pendiente}
          onQuitar={(itemId) => correr(() => quitarItemMenu({ eventoId: evento.id, itemId }))}
        />
        <ListaMenu
          titulo="Bebidas"
          items={bebidas}
          vacio="Sin bebidas anotadas."
          pendiente={pendiente}
          onQuitar={(itemId) => correr(() => quitarItemMenu({ eventoId: evento.id, itemId }))}
        />
        <ListaMenu
          titulo="No comestibles"
          items={noComestibles}
          vacio="Carbón, hielo, vasos: se anotan acá y van a la compra, nunca a la despensa de comida."
          pendiente={pendiente}
          onQuitar={(itemId) => correr(() => quitarItemMenu({ eventoId: evento.id, itemId }))}
        />

        {sinClasificar.length > 0 && (
          <div className="mb-md">
            <Notice icon="help">
              Hay {sinClasificar.length} item(s) guardados con una clase que esta versión de la
              aplicación no conoce ({sinClasificar.map((i) => i.tipoCrudo).join(", ")}). Hasta que
              se puedan leer, el cálculo no corre: tratarlos como acompañamiento podría dejar una
              carne fuera de la compra.
            </Notice>
          </div>
        )}

        {carnes.length > 1 && (
          <EditorReparto
            carnes={carnes}
            pendiente={pendiente}
            onGuardar={(reparto) =>
              correr(() => guardarDistribucion({ eventoId: evento.id, reparto }))
            }
          />
        )}

        <FormularioItemMenu
          pendiente={pendiente}
          onAgregar={(datos) => correr(() => agregarItemMenu({ eventoId: evento.id, ...datos }))}
        />
      </Section>

      <Section
        title="Qué comidas del plan reemplaza"
        hint="Sin esta respuesta se compra dos veces: el evento Y la comida de ese día."
      >
        <Card className="space-y-md p-md">
          <ElegirVarias
            titulo="Este evento reemplaza…"
            hint="Marca TODAS las comidas de ese día que la gente que va no se va a servir. Un asado que empieza a la una y sigue de noche reemplaza el almuerzo Y la cena; si sólo marcas el almuerzo, la cena se compra igual."
            opciones={MEAL_TYPES.map((m) => ({ valor: m, texto: MEAL_TYPE_LABELS[m] }))}
            marcadas={cubiertas}
            desconocidas={cubiertasDesconocidas}
            pendiente={pendiente}
            bloqueado={evento.estado === "COMPLETED" || evento.estado === "CANCELLED"}
            onMarcar={(valor) =>
              correr(() => agregarComidaCubierta({ eventoId: evento.id, comida: valor }))
            }
            onDesmarcar={(valor) =>
              correr(() => quitarComidaCubierta({ eventoId: evento.id, comida: valor }))
            }
          />
          {relevos.length > 0 ? (
            <Notice icon="event_available" tono="info">
              <p className="font-semibold">Esto ya no se compra:</p>
              <ul className="mt-sm list-inside list-disc">
                {relevos.map((r) => (
                  <li key={`${r.fecha}-${r.comidaCruda}`} className="min-w-0">
                    {textoDelRelevo(r)}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : (
            <Notice icon="shopping_cart">
              <p className="font-semibold">Este evento todavía no reemplaza ninguna comida.</p>
              <p className="mt-0.5">
                {comidasCubiertas.length === 0
                  ? "Falta decir qué comidas reemplaza: mientras no se diga, ese día se compra el evento Y la comida del plan."
                  : evento.estado !== "CONFIRMED" && evento.estado !== "IN_PROGRESS"
                    ? "El plan se libera al CONFIRMAR el evento. Hasta entonces la comida de ese día sigue en la lista de compras, que es lo correcto: todavía puede no ocurrir."
                    : "Nadie del hogar figura yendo, o ese día no hay una comida confirmada en el plan. Un evento releva a personas, no a fechas."}
              </p>
            </Notice>
          )}
        </Card>
      </Section>

      <Section title="Cómo calcular" hint="Cada una de estas respuestas mueve la cantidad.">
        <Card className="space-y-md p-md">
          <ElegirUno
            titulo="¿Qué comida es este asado?"
            opciones={CONTEXTOS_COMIDA.map((c) => ({ valor: c, texto: ETIQUETA_CONTEXTO[c] }))}
            actual={evento.contextoComida}
            pendiente={pendiente}
            onElegir={(valor) =>
              correr(() =>
                guardarConfiguracion({
                  eventoId: evento.id,
                  contextoComida: valor as (typeof CONTEXTOS_COMIDA)[number] | null,
                }),
              )
            }
          />
          <ElegirUno
            titulo="¿Cuántos acompañamientos habrá?"
            opciones={NIVELES_ACOMPANAMIENTO.map((n) => ({
              valor: n,
              texto: ETIQUETA_ACOMPANAMIENTO[n],
            }))}
            actual={evento.nivelAcompanamiento}
            pendiente={pendiente}
            onElegir={(valor) =>
              correr(() =>
                guardarConfiguracion({
                  eventoId: evento.id,
                  nivelAcompanamiento: valor as (typeof NIVELES_ACOMPANAMIENTO)[number] | null,
                }),
              )
            }
          />
          <ElegirUno
            titulo="¿Quieres que sobre?"
            opciones={SOBRANTES_DESEADOS.map((s) => ({ valor: s, texto: ETIQUETA_SOBRANTE[s] }))}
            actual={evento.sobranteDeseado}
            pendiente={pendiente}
            onElegir={(valor) =>
              correr(() =>
                guardarConfiguracion({
                  eventoId: evento.id,
                  sobranteDeseado: valor as (typeof SOBRANTES_DESEADOS)[number] | null,
                }),
              )
            }
          />
          <ElegirUno
            titulo="Margen por si acaso"
            hint="Es otra cosa que el sobrante: esto cubre que la estimación se quede corta, no la comida del domingo."
            opciones={[
              { valor: "0", texto: "Sin margen" },
              { valor: "5", texto: "5 %" },
              { valor: "10", texto: "10 %" },
              { valor: "15", texto: "15 %" },
            ]}
            actual={
              evento.bufferSeguridadPct === null ? null : String(evento.bufferSeguridadPct)
            }
            pendiente={pendiente}
            onElegir={(valor) =>
              correr(() =>
                guardarConfiguracion({
                  eventoId: evento.id,
                  bufferSeguridadPct: valor === null ? null : Number(valor),
                }),
              )
            }
          />
        </Card>
      </Section>

      <Section title="La estimación">
        <Card className="space-y-md p-md">
          {revision === null ? (
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Este evento todavía no tiene estimación. No es cero comida: es que no se ha
              calculado.
            </p>
          ) : (
            <>
              <DataRow label="Carne servible estimada">
                {formatearRango(revision.salida.totalServableDemand)}
              </DataRow>
              <DataRow label="Confianza">
                <Chip tono={TONO_CONFIANZA[revision.salida.confidence]}>
                  {TEXTO_CONFIANZA[revision.salida.confidence]}
                </Chip>
              </DataRow>
              <DataRow label="Revisión">
                #{revision.numero} · {revision.salida.engineVersion}
              </DataRow>
              {revision.salida.reviewRequired.length > 0 && (
                <Notice icon="warning">
                  Hay {revision.salida.reviewRequired.length} punto(s) que necesitan que los mires
                  antes de comprar.
                </Notice>
              )}
            </>
          )}
          <div className="flex flex-wrap gap-sm">
            <Button
              disabled={pendiente}
              onClick={() => correr(() => calcularEstimacion({ eventoId: evento.id }))}
            >
              {revision === null ? "Calcular cuánto comprar" : "Volver a calcular"}
            </Button>
            {revision !== null && (
              <LinkButton href={`/eventos/${evento.id}/estimacion`} variant="outline">
                Ver el detalle
              </LinkButton>
            )}
            {/* La demanda del evento entra a la lista de compras de siempre
                (Etapa 4). Sin esta puerta la pantalla existiría y nadie la
                encontraría. */}
            {revision !== null && (
              <LinkButton href={`/eventos/${evento.id}/compras`} variant="outline">
                Qué comprar
              </LinkButton>
            )}
          </div>
        </Card>
      </Section>

      {/* ------------------------------------------------------------------ */}
      {/* DESPUÉS                                                            */}
      {/* ------------------------------------------------------------------ */}

      {yaPaso && (
        <Section title="Después del evento">
          <Card className="space-y-sm p-md">
            <DataRow label="Asistencia">{asistencia.texto}</DataRow>
            {asistencia.estado === "NO_REGISTRADA" ? (
              // Nadie pasó lista, que es lo normal cuando el anfitrión está
              // asando. Cero marcas NO es cero personas: se muestran los
              // confirmados y se dice que es una estimación.
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                Nadie marcó quién llegó. Para lo que sigue usamos {personas(asistencia.personas)}{" "}
                confirmadas, y eso es una estimación, no un conteo.
              </p>
            ) : asistencia.estado === "PARCIAL" ? (
              // Lista a medias: el número de arriba es un PISO. Los que faltan
              // por marcar pueden haber llegado igual.
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                Quedaron {personas(asistencia.sinMarcar)} confirmadas sin marcar: de esas no
                sabemos si llegaron o no. El número de arriba es un mínimo, no el total.
              </p>
            ) : (
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {personas(asistencia.personas)} de {personas(participantes.length)} anotadas.
              </p>
            )}
          </Card>
        </Section>
      )}

      <p className="font-body-sm text-body-sm text-outline">
        <Link href="/eventos" className="underline">
          Volver a los eventos
        </Link>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Piezas de la pantalla
// ---------------------------------------------------------------------------

function ListaMenu({
  titulo,
  items,
  vacio,
  pendiente,
  onQuitar,
}: {
  titulo: string;
  items: ItemMenu[];
  vacio: string;
  pendiente: boolean;
  onQuitar: (itemId: string) => void;
}) {
  return (
    <div className="mb-md">
      <p className="mb-sm font-body-sm text-body-sm font-semibold text-on-surface-variant">
        {titulo}
      </p>
      {items.length === 0 ? (
        <p className="font-body-sm text-body-sm text-outline">{vacio}</p>
      ) : (
        <ul className="space-y-sm">
          {items.map((i) => (
            <li key={i.id}>
              <Card className="flex flex-wrap items-center justify-between gap-sm p-md">
                <span className="min-w-0 font-body-md text-body-md text-on-surface">
                  {i.nombre}
                  {i.categoria && (
                    <span className="text-on-surface-variant"> · {ETIQUETA_CATEGORIA[i.categoria]}</span>
                  )}
                </span>
                <span className="flex items-center gap-md">
                  {/* Sin porcentaje no es 0 %: es "que reparta el cálculo". */}
                  <Chip>
                    {i.porcentaje === null
                      ? "Reparto automático"
                      : `${i.porcentaje.toLocaleString("es-CL")} %`}
                  </Chip>
                  <button
                    type="button"
                    disabled={pendiente}
                    onClick={() => onQuitar(i.id)}
                    className="font-body-sm text-body-sm font-semibold text-on-surface-variant underline disabled:opacity-40"
                  >
                    Quitar
                  </button>
                </span>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * El reparto entre carnes (§21).
 *
 * Primero se estima el TOTAL de carne servible y recién después se decide qué
 * parte es vacuno y qué parte pollo. Por eso acá se editan porcentajes y no
 * kilos: escribir kilos por corte invita a sumar cuatro cantidades completas y
 * comprar el cuádruple, que es exactamente el error que este reparto evita.
 *
 * Dejar todo vacío es válido y significa AUTOMÁTICO. Lo que no se acepta es una
 * mezcla, ni una suma distinta de 100: eso lo rechaza la acción con el número
 * que falta escrito en el mensaje.
 */
function EditorReparto({
  carnes,
  pendiente,
  onGuardar,
}: {
  carnes: ItemMenu[];
  pendiente: boolean;
  onGuardar: (reparto: { itemId: string; porcentaje: number | null }[]) => void;
}) {
  const [valores, setValores] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      carnes.map((c) => [c.id, c.porcentaje === null ? "" : String(c.porcentaje)]),
    ),
  );

  const suma = carnes.reduce((acc, c) => {
    const n = Number((valores[c.id] ?? "").replace(",", "."));
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);
  const algunoConValor = carnes.some((c) => (valores[c.id] ?? "").trim().length > 0);

  return (
    <Card className="mb-md space-y-md p-md">
      <p className="font-body-sm text-body-sm text-on-surface-variant">
        ¿Cómo se reparte la carne entre los cortes? Déjalo en blanco para que lo reparta el
        cálculo.
      </p>
      {carnes.map((c) => (
        <label key={c.id} className="flex flex-wrap items-center justify-between gap-sm">
          <span className="min-w-0 font-body-md text-body-md text-on-surface">{c.nombre}</span>
          <span className="flex items-center gap-sm">
            <input
              value={valores[c.id] ?? ""}
              onChange={(e) => setValores({ ...valores, [c.id]: e.target.value })}
              inputMode="decimal"
              placeholder="auto"
              aria-label={`Porcentaje de ${c.nombre}`}
              className={`${CAMPO} w-24 text-right`}
            />
            <span className="font-body-sm text-body-sm text-on-surface-variant">%</span>
          </span>
        </label>
      ))}
      {algunoConValor && (
        <p
          className={`font-body-sm text-body-sm ${
            Math.abs(suma - 100) > 1 ? "text-error" : "text-on-surface-variant"
          }`}
        >
          Suman {suma.toLocaleString("es-CL")} % de 100 %.
        </p>
      )}
      <Button
        disabled={pendiente}
        onClick={() =>
          onGuardar(
            carnes.map((c) => {
              const crudo = (valores[c.id] ?? "").trim();
              const n = Number(crudo.replace(",", "."));
              // Vacío es AUTOMÁTICO, no cero por ciento: cero por ciento
              // significaría "de este corte no compres nada".
              return { itemId: c.id, porcentaje: crudo.length === 0 || !Number.isFinite(n) ? null : n };
            }),
          )
        }
      >
        Guardar reparto
      </Button>
    </Card>
  );
}

function FormularioItemMenu({
  pendiente,
  onAgregar,
}: {
  pendiente: boolean;
  onAgregar: (datos: {
    tipo: "MEAT" | "SIDE" | "BEVERAGE" | "NON_FOOD";
    categoria: CategoriaMenu | null;
    nombre: string;
    ingredientId: null;
    productId: null;
    porcentaje: number | null;
  }) => void;
}) {
  const [tipo, setTipo] = useState<"MEAT" | "SIDE" | "BEVERAGE" | "NON_FOOD">("MEAT");
  const [categoria, setCategoria] = useState<CategoriaMenu>("VACUNO");
  const [nombre, setNombre] = useState("");

  return (
    <Card className="space-y-md p-md">
      <div className="flex flex-wrap gap-sm">
        {(["MEAT", "SIDE", "BEVERAGE", "NON_FOOD"] as const).map((t) => (
          <ToggleChip key={t} activo={tipo === t} onClick={() => setTipo(t)}>
            {t === "MEAT"
              ? "Carne"
              : t === "SIDE"
                ? "Acompañamiento"
                : t === "BEVERAGE"
                  ? "Bebida"
                  : "No comestible"}
          </ToggleChip>
        ))}
      </div>

      {tipo === "MEAT" && (
        <label className="block">
          <span className="font-body-sm text-body-sm text-on-surface-variant">Categoría</span>
          <select
            value={categoria}
            onChange={(e) => setCategoria(e.target.value as CategoriaMenu)}
            className={`${CAMPO} mt-1`}
          >
            {CATEGORIAS_MENU.map((c) => (
              <option key={c} value={c}>
                {ETIQUETA_CATEGORIA[c]}
              </option>
            ))}
          </select>
        </label>
      )}

      <TextField
        label="¿Qué es?"
        value={nombre}
        onChange={setNombre}
        placeholder={tipo === "MEAT" ? "Lomo vetado" : "Ensalada chilena"}
      />

      <Button
        disabled={pendiente || nombre.trim().length === 0}
        onClick={() => {
          onAgregar({
            tipo,
            categoria: tipo === "MEAT" ? categoria : null,
            nombre: nombre.trim(),
            ingredientId: null,
            productId: null,
            // Nace en reparto automático. Poner 100 % a la primera carne haría
            // que agregar la segunda dejara la suma en 200.
            porcentaje: null,
          });
          setNombre("");
        }}
      >
        Agregar al menú
      </Button>
    </Card>
  );
}

/**
 * Una pregunta de VARIAS respuestas, cada clic un hecho.
 *
 * Gemela de `ElegirUno` en aspecto y opuesta en semántica, y la diferencia
 * importa: acá marcar una casilla no desmarca las otras. Un asado que da
 * almuerzo y cena son dos declaraciones, no una elección entre dos.
 *
 * NO acumula estado propio ni manda la lista entera. Cada toque llama a marcar
 * o a desmarcar UNA comida y la pantalla se recarga con lo que la base dijo.
 * Un componente que guardara la selección en memoria y la enviara completa
 * tendría que resolver la diferencia contra una lectura que puede tener diez
 * segundos: dos personas marcando casillas a la vez terminan con una pisando lo
 * de la otra, y lo que se pisa es qué se compra.
 *
 * `desconocidas` son las comidas que la base tiene y esta versión de la app no
 * sabe nombrar. Se muestran con su código y sin poder tocarlas: esconderlas
 * mostraría menos cobertura de la que hay, y de esa diferencia sale una compra
 * de más.
 */
function ElegirVarias({
  titulo,
  hint,
  opciones,
  marcadas,
  desconocidas,
  pendiente,
  bloqueado,
  onMarcar,
  onDesmarcar,
}: {
  titulo: string;
  hint?: string;
  opciones: { valor: string; texto: string }[];
  marcadas: Set<string>;
  desconocidas: string[];
  pendiente: boolean;
  bloqueado: boolean;
  onMarcar: (valor: string) => void;
  onDesmarcar: (valor: string) => void;
}) {
  return (
    <div>
      <p className="font-body-sm text-body-sm text-on-surface-variant">{titulo}</p>
      {hint && <p className="font-body-sm text-body-sm text-outline">{hint}</p>}
      <div className="mt-sm flex flex-wrap gap-sm">
        {opciones.map((o) => (
          <ToggleChip
            key={o.valor}
            activo={marcadas.has(o.valor)}
            disabled={pendiente || bloqueado}
            onClick={() => (marcadas.has(o.valor) ? onDesmarcar(o.valor) : onMarcar(o.valor))}
          >
            {o.texto}
          </ToggleChip>
        ))}
        {desconocidas.map((codigo) => (
          <ToggleChip
            key={codigo}
            activo
            disabled
            title="Comida guardada con un código que esta versión no conoce"
            onClick={() => undefined}
          >
            {codigo}
          </ToggleChip>
        ))}
      </div>
      {marcadas.size === 0 && desconocidas.length === 0 && (
        <p className="mt-1 font-body-sm text-body-sm text-outline">
          <Icon name="help" className="text-[14px]" /> {SIN_INFORMACION}: ese día se compra el
          evento Y la comida del plan.
        </p>
      )}
      {bloqueado && (marcadas.size > 0 || desconocidas.length > 0) && (
        <p className="mt-1 font-body-sm text-body-sm text-outline">
          <Icon name="lock" className="text-[14px]" /> El evento ya está cerrado: lo que cubrió es
          historia y no se cambia.
        </p>
      )}
    </div>
  );
}

/**
 * Una pregunta de una sola respuesta, con la opción de dejarla SIN RESPONDER.
 *
 * Volver a tocar la respuesta elegida la borra: eso permite pasar de "no quiero
 * que sobre" a "todavía no lo he pensado", que son dos cosas distintas y el
 * motor las trata distinto.
 */
function ElegirUno({
  titulo,
  hint,
  opciones,
  actual,
  pendiente,
  onElegir,
}: {
  titulo: string;
  hint?: string;
  opciones: { valor: string; texto: string }[];
  actual: string | null;
  pendiente: boolean;
  onElegir: (valor: string | null) => void;
}) {
  return (
    <div>
      <p className="font-body-sm text-body-sm text-on-surface-variant">{titulo}</p>
      {hint && <p className="font-body-sm text-body-sm text-outline">{hint}</p>}
      <div className="mt-sm flex flex-wrap gap-sm">
        {opciones.map((o) => (
          <ToggleChip
            key={o.valor}
            activo={actual === o.valor}
            disabled={pendiente}
            onClick={() => onElegir(actual === o.valor ? null : o.valor)}
          >
            {o.texto}
          </ToggleChip>
        ))}
      </div>
      {actual === null && (
        <p className="mt-1 font-body-sm text-body-sm text-outline">
          <Icon name="help" className="text-[14px]" /> {SIN_INFORMACION}: el cálculo lo va a decir.
        </p>
      )}
    </div>
  );
}
