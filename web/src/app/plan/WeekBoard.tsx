"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { dayOfMonth, weekdayName } from "@/domain/nutrition/calendar";
import { eventCoversDate } from "@/domain/nutrition/events";
import { MEAL_TYPE_LABELS, type MealType } from "@/domain/recipes/types";
import { Button, ButtonOutline, Card, Chip, ErrorNote, Icon, Notice } from "@/components/ui";
import type { WeekPlan } from "./queries";
import {
  assignMeal,
  clearAssignment,
  confirmMeal,
  deleteEvent,
  saveEvent,
  setMealParticipants,
  unconfirmMeal,
} from "./actions";
import { servirLoPlanificado } from "./servir-actions";

/**
 * El tablero de la semana. Mobile-first: siete tarjetas de día, una debajo de la
 * otra, y dentro de cada una las comidas del patrón familiar.
 *
 * Confirmar una comida es el momento en que las porciones dejan de ser una
 * proyección y quedan guardadas con todas sus versiones.
 */

/** Las cuatro de todos los días. */
const COMIDAS_BASE: MealType[] = ["BREAKFAST", "LUNCH", "TEA", "DINNER"];
/**
 * Las que aparecen solo cuando hacen falta. La base las soporta desde el Sprint
 * 3 — era el tablero el que las escondía, y una once con postre terminaba
 * escrita como "otra cosa" o simplemente no se planificaba.
 */
const COMIDAS_EXTRA: MealType[] = ["DESSERT", "SNACK", "FRUIT", "OTHER"];

/** Cada comida con su icono del kit: el momento del día se reconoce sin leer. */
const MEAL_ICONS: Record<MealType, string> = {
  BREAKFAST: "wb_sunny",
  LUNCH: "lunch_dining",
  TEA: "local_cafe",
  DINNER: "dinner_dining",
  DESSERT: "icecream",
  SNACK: "cookie",
  FRUIT: "nutrition",
  OTHER: "restaurant",
};

const KIND_LABELS: Record<string, string> = {
  RECIPE: "Receta",
  EAT_OUT: "Comemos afuera",
  LEFTOVER: "Sobras",
  EVENT: "Evento",
  FREE: "Libre",
};

const EVENT_LABELS: Record<string, string> = {
  BIRTHDAY: "Cumpleaños",
  BARBECUE: "Asado",
  TRAVEL: "Viaje",
  FREE_MEAL: "Comida libre",
  HOLIDAY: "Feriado",
  ILLNESS: "Enfermedad",
  OTHER: "Otro",
};

const STRATEGY_LABELS: Record<string, string> = {
  AS_PLANNED: "Como siempre",
  RELAXED: "Con margen",
  LIGHTER_AROUND: "Más liviano alrededor",
  SKIP_TRACKING: "Sin conteo ese día",
};

/** Campo de formulario del kit: mismo alto de toque en todos lados. */
const FIELD =
  "w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";

/** Botón chico de una fila de comida: cabe en 320 px al lado del título. */
const BOTON_FILA =
  "inline-flex shrink-0 items-center gap-1 rounded-full border border-outline px-3 py-1.5 font-label-md text-label-md text-on-surface-variant transition-transform active:scale-95";

/** Enlace de texto dentro de una comida. */
const ENLACE = "font-body-sm text-body-sm font-semibold text-primary underline";

export function WeekBoard({
  week,
  recipes,
  members,
  today,
}: {
  week: WeekPlan;
  recipes: { templateId: string; versionId: string; name: string; mealTypes: MealType[] }[];
  members: { id: string; name: string }[];
  today: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [eventoAbierto, setEventoAbierto] = useState(false);
  const [comensalesAbierto, setComensalesAbierto] = useState<string | null>(null);
  const [diasExpandidos, setDiasExpandidos] = useState<string[]>([]);

  function run(action: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "No se pudo completar.");
        return;
      }
      setMessage(result.message ?? "Listo.");
      setAbierto(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-md">
      {/* La otra mitad del día. Servir saca la comida a la mesa; lo que se comió
          de verdad lo dice una persona, y eso vive en /comi. Sin esta puerta la
          pantalla solo se alcanza escribiendo la dirección a mano. */}
      <div className="flex justify-end">
        <Link href="/comi" className={ENLACE}>
          Anotar lo que se comió
        </Link>
      </div>

      {message && (
        <p className="flex items-start gap-sm rounded-2xl bg-primary-fixed px-md py-sm font-body-sm text-body-sm text-on-primary-fixed">
          <Icon name="check_circle" className="mt-0.5 shrink-0 text-[18px]" />
          {message}
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}

      {week.days.map((day) => {
        // Un viaje de jueves a domingo tiene que verse los cuatro días, no solo
        // el jueves.
        const eventos = week.events.filter((e) => eventCoversDate(e, day.date));
        const esHoy = day.date === today;
        return (
          <Card
            as="section"
            key={day.id}
            className={`p-md ${esHoy ? "border-2 border-primary" : ""}`}
          >
            <header className="mb-sm flex items-center justify-between gap-sm">
              <h2 className="font-headline-sm text-headline-sm capitalize text-on-surface">
                {weekdayName(day.date)} {dayOfMonth(day.date)}
              </h2>
              {esHoy && (
                <Chip tono="primario" icon="today">
                  hoy
                </Chip>
              )}
            </header>

            {eventos.length > 0 && (
              <ul className="mb-sm space-y-1">
                {eventos.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-start justify-between gap-sm rounded-2xl bg-secondary-fixed px-md py-sm text-on-secondary-fixed-variant"
                  >
                    <span className="min-w-0 font-body-sm text-body-sm">
                      <Icon name="celebration" className="mr-1 align-middle text-[16px]" />
                      <strong className="font-semibold">{e.title}</strong> ·{" "}
                      {EVENT_LABELS[e.eventType] ?? e.eventType} ·{" "}
                      {STRATEGY_LABELS[e.strategy] ?? e.strategy}
                    </span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => deleteEvent(e.id))}
                      className="shrink-0 font-body-sm text-body-sm font-semibold underline disabled:opacity-40"
                    >
                      Quitar
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-sm">
              {[
                ...COMIDAS_BASE,
                ...COMIDAS_EXTRA.filter(
                  (m) =>
                    day.assignments.some((a) => a.mealType === m) ||
                    diasExpandidos.includes(day.id),
                ),
              ].map((mealType) => {
                const asignacion = day.assignments.find((a) => a.mealType === mealType);
                const clave = `${day.id}:${mealType}`;
                const confirmada = asignacion?.status === "CONFIRMED" || asignacion?.status === "SERVED";

                return (
                  <div
                    key={mealType}
                    className="overflow-hidden rounded-2xl border border-outline-variant/60"
                  >
                    <div className="flex items-start justify-between gap-sm px-md py-sm">
                      <div className="flex min-w-0 flex-1 items-start gap-sm">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-container text-primary">
                          <Icon name={MEAL_ICONS[mealType]} className="text-[18px]" />
                        </span>
                        <div className="min-w-0">
                          <p className="font-label-md text-label-md uppercase text-on-surface-variant">
                            {MEAL_TYPE_LABELS[mealType]}
                          </p>
                          {asignacion ? (
                            <p className="truncate font-body-md text-body-md font-semibold text-on-surface">
                              {asignacion.kind === "RECIPE"
                                ? asignacion.recipeName
                                : (KIND_LABELS[asignacion.kind] ?? asignacion.kind)}
                              {asignacion.versionNumber && (
                                <span className="ml-1.5 font-body-sm text-body-sm font-normal text-outline">
                                  v{asignacion.versionNumber}
                                </span>
                              )}
                            </p>
                          ) : (
                            <p className="font-body-sm text-body-sm text-outline">Sin planificar</p>
                          )}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setAbierto(abierto === clave ? null : clave)}
                        className={BOTON_FILA}
                      >
                        <Icon name={asignacion ? "edit" : "add"} className="text-[14px]" />
                        {asignacion ? "Cambiar" : "Planificar"}
                      </button>
                    </div>

                    {/* Los chips van en su propia fila: en 320 px "requiere
                        revisión para 3 integrantes" no cabe al lado del título. */}
                    <div className="flex flex-wrap items-center gap-1.5 px-md pb-sm empty:hidden">
                      {asignacion?.needsReview && (
                        <span title={asignacion.reviewReason ?? undefined}>
                          <Chip tono="atencion" icon="error">
                            revisar
                          </Chip>
                        </span>
                      )}
                      {confirmada && (
                        <Chip tono="primario" icon="check_circle">
                          {asignacion!.servingCount} porciones
                        </Chip>
                      )}
                      {/* `asignacion` puede no existir (comida sin planificar):
                          leerla con `!` reventaba la fila entera. */}
                      {(asignacion?.clinicalReviewCount ?? 0) > 0 && (
                        <Chip tono="atencion" icon="warning">
                          requiere revisión para {asignacion!.clinicalReviewCount}{" "}
                          {asignacion!.clinicalReviewCount === 1 ? "integrante" : "integrantes"}
                        </Chip>
                      )}
                      {/* Una comida confirmada cuyas porciones nunca pasaron por
                          el motor clínico no puede verse igual que una evaluada
                          y limpia: en el tablero "limpia" es no tener chip, así
                          que SIN EVALUAR necesita el suyo — UNKNOWN NUNCA
                          SIGNIFICA NORMAL. Solo el conteo: el porqué vive en
                          Salud (§58). */}
                      {(asignacion?.clinicalUnassessedCount ?? 0) > 0 && (
                        <Chip tono="atencion" icon="help">
                          sin evaluación clínica: {asignacion!.clinicalUnassessedCount}{" "}
                          {asignacion!.clinicalUnassessedCount === 1 ? "porción" : "porciones"}
                        </Chip>
                      )}
                    </div>

                    {asignacion && (
                      <div className="border-t border-outline-variant/40 px-md py-sm">
                        <button
                          type="button"
                          onClick={() =>
                            setComensalesAbierto(
                              comensalesAbierto === asignacion.id ? null : asignacion.id,
                            )
                          }
                          className="text-left font-body-sm text-body-sm text-on-surface-variant underline"
                        >
                          Comen:{" "}
                          {asignacion.participantIds.length === 0
                            ? "todos"
                            : members
                                .filter((m) => asignacion.participantIds.includes(m.id))
                                .map((m) => m.name)
                                .join(", ")}
                        </button>

                        {comensalesAbierto === asignacion.id && (
                          <Comensales
                            members={members}
                            seleccionados={asignacion.participantIds}
                            pending={pending}
                            onGuardar={(ids) => run(() => setMealParticipants(asignacion.id, ids))}
                          />
                        )}
                      </div>
                    )}

                    {asignacion?.kind === "RECIPE" && (
                      <div className="flex flex-wrap items-center gap-sm border-t border-outline-variant/40 px-md py-sm">
                        <Link
                          href={`/recipes/${asignacion.templateId}/family?meal=${mealType}&v=${asignacion.versionId}&assignment=${asignacion.id}`}
                          className={ENLACE}
                        >
                          Ver porciones
                        </Link>
                        {confirmada ? (
                          <>
                            <Link href={`/plan/comida/${asignacion.id}`} className={ENLACE}>
                              Ver lo guardado
                            </Link>
                            {/* Este botón decía "Comimos lo planificado" y desde
                                la 0036 eso es MENTIRA: servir dejó de declarar
                                consumo, así que lo único que hace es sacar la
                                comida a la mesa y descontar la despensa. Quién
                                comió qué lo dice una persona, en /comi. */}
                            {asignacion.status === "CONFIRMED" && (
                              <ButtonOutline
                                disabled={pending}
                                onClick={() => run(() => servirLoPlanificado(asignacion.id))}
                              >
                                <Icon name="restaurant" className="text-[18px]" />
                                Servir lo planificado
                              </ButtonOutline>
                            )}
                            {asignacion.status === "SERVED" && (
                              <Link href="/comi" className={ENLACE}>
                                Anotar lo que se comió
                              </Link>
                            )}
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => run(() => unconfirmMeal(asignacion.id))}
                              className="font-body-sm text-body-sm text-on-surface-variant underline disabled:opacity-40"
                            >
                              Deshacer confirmación
                            </button>
                          </>
                        ) : (
                          <Button
                            disabled={pending}
                            onClick={() => run(() => confirmMeal(asignacion.id))}
                          >
                            <Icon name="check" className="text-[18px]" />
                            Confirmar y guardar porciones
                          </Button>
                        )}
                        {asignacion.needsReview && (
                          <div className="w-full">
                            <Notice icon="history">
                              {asignacion.reviewReason ?? "Algo cambió alrededor de esta comida"}.
                              Las porciones guardadas quedaron como estaban: deshaz la confirmación
                              si quieres recalcularlas.
                            </Notice>
                          </div>
                        )}
                      </div>
                    )}

                    {abierto === clave && (
                      <div className="space-y-sm border-t border-outline-variant/40 bg-surface-container-low px-md py-md">
                        <select
                          className={FIELD}
                          aria-label={`Planificar ${MEAL_TYPE_LABELS[mealType]}`}
                          defaultValue=""
                          onChange={(e) => {
                            const valor = e.target.value;
                            if (!valor) return;
                            if (valor.startsWith("kind:")) {
                              run(() =>
                                assignMeal({
                                  dayId: day.id,
                                  mealType,
                                  kind: valor.slice(5) as "EAT_OUT",
                                }),
                              );
                              return;
                            }
                            const receta = recipes.find((r) => r.versionId === valor);
                            if (receta) {
                              run(() =>
                                assignMeal({
                                  dayId: day.id,
                                  mealType,
                                  kind: "RECIPE",
                                  templateId: receta.templateId,
                                  versionId: receta.versionId,
                                }),
                              );
                            }
                          }}
                        >
                          <option value="">Elegir…</option>
                          <optgroup label="Recetas">
                            {recipes
                              .filter(
                                (r) => r.mealTypes.length === 0 || r.mealTypes.includes(mealType),
                              )
                              .map((r) => (
                                <option key={r.versionId} value={r.versionId}>
                                  {r.name}
                                </option>
                              ))}
                          </optgroup>
                          <optgroup label="Sin receta">
                            <option value="kind:EAT_OUT">Comemos afuera</option>
                            <option value="kind:LEFTOVER">Sobras</option>
                            <option value="kind:EVENT">Evento</option>
                            <option value="kind:FREE">Libre</option>
                          </optgroup>
                        </select>

                        {asignacion && (
                          <ButtonOutline
                            className="w-full"
                            disabled={pending}
                            onClick={() => run(() => clearAssignment(asignacion.id))}
                          >
                            <Icon name="delete" className="text-[18px]" />
                            Quitar de la semana
                          </ButtonOutline>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {!diasExpandidos.includes(day.id) &&
                !COMIDAS_EXTRA.some((m) => day.assignments.some((a) => a.mealType === m)) && (
                  <button
                    type="button"
                    onClick={() => setDiasExpandidos([...diasExpandidos, day.id])}
                    className="flex w-full items-center justify-center gap-sm rounded-2xl border border-dashed border-outline px-md py-sm font-body-sm text-body-sm font-semibold text-primary transition-transform active:scale-[0.99]"
                  >
                    <Icon name="add" className="text-[18px]" />
                    Postre, snack, fruta u otra comida
                  </button>
                )}
            </div>
          </Card>
        );
      })}

      <Card as="section" className="border border-dashed border-outline p-md">
        {!eventoAbierto ? (
          <button
            type="button"
            onClick={() => setEventoAbierto(true)}
            className="flex w-full items-center justify-center gap-sm rounded-2xl px-md py-sm font-body-md text-body-md font-semibold text-primary transition-transform active:scale-[0.99]"
          >
            <Icon name="celebration" className="text-[20px]" />
            Agregar un evento a la semana
          </button>
        ) : (
          <EventForm
            householdId={week.householdId}
            dias={week.days.map((d) => d.date)}
            members={members}
            pending={pending}
            onSave={run}
            onCancel={() => setEventoAbierto(false)}
          />
        )}
      </Card>
    </div>
  );
}

/**
 * Quiénes comen esta comida. Vacío no es "nadie": es "todos", que es lo normal.
 * Por eso el botón dice "come toda la familia" y no obliga a marcar cinco casillas
 * cada almuerzo.
 */
function Comensales({
  members,
  seleccionados,
  pending,
  onGuardar,
}: {
  members: { id: string; name: string }[];
  seleccionados: string[];
  pending: boolean;
  onGuardar: (ids: string[]) => void;
}) {
  const [marcados, setMarcados] = useState<string[]>(
    seleccionados.length === 0 ? members.map((m) => m.id) : seleccionados,
  );
  const todos = marcados.length === members.length;

  return (
    <div className="mt-sm space-y-sm rounded-2xl bg-surface-container p-md">
      <ul className="space-y-1">
        {members.map((m) => (
          <li key={m.id}>
            <label className="flex items-center gap-sm font-body-md text-body-md text-on-surface">
              <input
                type="checkbox"
                className="size-5 shrink-0 accent-primary"
                checked={marcados.includes(m.id)}
                onChange={(e) =>
                  setMarcados(
                    e.target.checked
                      ? [...marcados, m.id]
                      : marcados.filter((id) => id !== m.id),
                  )
                }
              />
              {m.name}
            </label>
          </li>
        ))}
      </ul>
      {marcados.length === 0 && (
        <Notice icon="info">Si no come nadie, mejor quita la comida de la semana.</Notice>
      )}
      <Button
        full
        disabled={pending || marcados.length === 0}
        onClick={() => onGuardar(todos ? [] : marcados)}
      >
        Guardar quién come
      </Button>
    </div>
  );
}

function EventForm({
  householdId,
  dias,
  members,
  pending,
  onSave,
  onCancel,
}: {
  householdId: string;
  dias: string[];
  members: { id: string; name: string }[];
  pending: boolean;
  onSave: (a: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
  onCancel: () => void;
}) {
  const [fecha, setFecha] = useState(dias[0] ?? "");
  const [hasta, setHasta] = useState("");
  const [titulo, setTitulo] = useState("");
  const [tipo, setTipo] = useState("BARBECUE");
  const [comida, setComida] = useState<MealType | "">("LUNCH");
  const [estrategia, setEstrategia] = useState("RELAXED");
  const [afectados, setAfectados] = useState<string[]>([]);

  return (
    <div className="space-y-md">
      <h3 className="font-headline-sm text-headline-sm text-on-surface">Evento de la semana</h3>
      <p className="font-body-sm text-body-sm text-on-surface-variant">
        Un asado, un cumpleaños o un viaje. Da margen ese día sin compensar en los otros: nadie
        &quot;paga&quot; una comida con un día de ayuno.
      </p>

      <input
        value={titulo}
        onChange={(e) => setTitulo(e.target.value)}
        placeholder="Asado en casa de mi hermana"
        aria-label="Título del evento"
        className={FIELD}
      />

      <div className="flex flex-wrap gap-sm">
        <select
          value={fecha}
          onChange={(e) => setFecha(e.target.value)}
          aria-label="Día del evento"
          className={`${FIELD} flex-1`}
        >
          {dias.map((d) => (
            <option key={d} value={d}>
              {weekdayName(d)} {dayOfMonth(d)}
            </option>
          ))}
        </select>
        <select
          value={tipo}
          onChange={(e) => setTipo(e.target.value)}
          aria-label="Tipo de evento"
          className={`${FIELD} flex-1`}
        >
          {Object.entries(EVENT_LABELS).map(([valor, texto]) => (
            <option key={valor} value={valor}>
              {texto}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-sm">
        <select
          value={comida}
          onChange={(e) => setComida(e.target.value as MealType | "")}
          aria-label="Comida afectada"
          className={`${FIELD} flex-1`}
        >
          <option value="">Todo el día</option>
          {[...COMIDAS_BASE, ...COMIDAS_EXTRA].map((m) => (
            <option key={m} value={m}>
              {MEAL_TYPE_LABELS[m]}
            </option>
          ))}
        </select>
        <select
          value={estrategia}
          onChange={(e) => setEstrategia(e.target.value)}
          aria-label="Estrategia del día"
          className={`${FIELD} flex-1`}
        >
          {Object.entries(STRATEGY_LABELS).map(([valor, texto]) => (
            <option key={valor} value={valor}>
              {texto}
            </option>
          ))}
        </select>
      </div>

      <label className="block font-body-sm text-body-sm text-on-surface-variant">
        Si dura varios días (un viaje), hasta cuándo
        <select
          value={hasta}
          onChange={(e) => setHasta(e.target.value)}
          className={`${FIELD} mt-1`}
        >
          <option value="">Solo ese día</option>
          {dias
            .filter((d) => d > fecha)
            .map((d) => (
              <option key={d} value={d}>
                {weekdayName(d)} {dayOfMonth(d)}
              </option>
            ))}
        </select>
      </label>

      <fieldset>
        <legend className="font-body-sm text-body-sm text-on-surface-variant">
          ¿A quién afecta? Sin marcar a nadie, es de toda la familia.
        </legend>
        <ul className="mt-sm flex flex-wrap gap-sm">
          {members.map((m) => (
            <li key={m.id}>
              <label className="flex items-center gap-sm rounded-full border border-outline-variant px-3 py-1.5 font-body-sm text-body-sm text-on-surface">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-primary"
                  checked={afectados.includes(m.id)}
                  onChange={(e) =>
                    setAfectados(
                      e.target.checked
                        ? [...afectados, m.id]
                        : afectados.filter((id) => id !== m.id),
                    )
                  }
                />
                {m.name}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div className="flex flex-wrap gap-sm">
        <ButtonOutline className="flex-1" onClick={onCancel}>
          Cancelar
        </ButtonOutline>
        <Button
          className="flex-1"
          disabled={pending}
          onClick={() =>
            onSave(async () => {
              const r = await saveEvent({
                householdId,
                date: fecha,
                endDate: hasta || null,
                eventType: tipo,
                mealType: comida === "" ? null : comida,
                strategy: estrategia,
                title: titulo,
                memberIds: afectados,
              });
              if (r.ok) {
                setTitulo("");
                setAfectados([]);
                setHasta("");
                onCancel();
              }
              return r;
            })
          }
        >
          Guardar evento
        </Button>
      </div>
    </div>
  );
}
