"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { dayOfMonth, weekdayName } from "@/domain/nutrition/calendar";
import { eventCoversDate } from "@/domain/nutrition/events";
import { MEAL_TYPE_LABELS, type MealType } from "@/domain/recipes/types";
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
import { consumePlannedMeal } from "@/app/pantry/actions";

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

  const field = "w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2 text-base";

  return (
    <div className="space-y-3">
      {message && (
        <p className="rounded-xl bg-[var(--accent)]/10 px-3 py-2 text-sm text-[var(--accent)]">
          {message}
        </p>
      )}
      {error && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      {week.days.map((day) => {
        // Un viaje de jueves a domingo tiene que verse los cuatro días, no solo
        // el jueves.
        const eventos = week.events.filter((e) => eventCoversDate(e, day.date));
        const esHoy = day.date === today;
        return (
          <section
            key={day.id}
            className={`rounded-2xl border bg-white p-4 ${
              esHoy ? "border-[var(--accent)]" : "border-[var(--ink)]/10"
            }`}
          >
            <header className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">
                {weekdayName(day.date)} {dayOfMonth(day.date)}
                {esHoy && (
                  <span className="ml-2 rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] text-white">
                    hoy
                  </span>
                )}
              </h2>
            </header>

            {eventos.length > 0 && (
              <ul className="mb-2 space-y-1">
                {eventos.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center justify-between gap-2 rounded-xl bg-amber-50 px-3 py-1.5 text-xs text-amber-900"
                  >
                    <span>
                      <strong>{e.title}</strong> · {EVENT_LABELS[e.eventType] ?? e.eventType} ·{" "}
                      {STRATEGY_LABELS[e.strategy] ?? e.strategy}
                    </span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => deleteEvent(e.id))}
                      className="shrink-0 underline"
                    >
                      Quitar
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-1.5">
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
                  <div key={mealType} className="rounded-xl border border-[var(--ink)]/10">
                    <div className="flex items-center justify-between gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-xs text-[var(--ink)]/60">{MEAL_TYPE_LABELS[mealType]}</p>
                        {asignacion ? (
                          <p className="truncate text-sm font-medium">
                            {asignacion.kind === "RECIPE"
                              ? asignacion.recipeName
                              : (KIND_LABELS[asignacion.kind] ?? asignacion.kind)}
                            {asignacion.versionNumber && (
                              <span className="ml-1.5 text-[11px] font-normal text-[var(--ink)]/40">
                                v{asignacion.versionNumber}
                              </span>
                            )}
                          </p>
                        ) : (
                          <p className="text-sm text-[var(--ink)]/40">Sin planificar</p>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {asignacion?.needsReview && (
                          <span
                            className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-900"
                            title={asignacion.reviewReason ?? undefined}
                          >
                            revisar
                          </span>
                        )}
                        {confirmada && (
                          <span className="rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] text-[var(--accent)]">
                            {asignacion!.servingCount} porciones
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setAbierto(abierto === clave ? null : clave)}
                          className="text-xs text-[var(--accent)] underline"
                        >
                          {asignacion ? "Cambiar" : "Planificar"}
                        </button>
                      </div>
                    </div>

                    {asignacion && (
                      <div className="border-t border-[var(--ink)]/5 px-3 py-2">
                        <button
                          type="button"
                          onClick={() =>
                            setComensalesAbierto(
                              comensalesAbierto === asignacion.id ? null : asignacion.id,
                            )
                          }
                          className="text-xs text-[var(--ink)]/60 underline"
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
                      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--ink)]/5 px-3 py-2">
                        <Link
                          href={`/recipes/${asignacion.templateId}/family?meal=${mealType}&v=${asignacion.versionId}&assignment=${asignacion.id}`}
                          className="text-xs text-[var(--accent)] underline"
                        >
                          Ver porciones
                        </Link>
                        {confirmada ? (
                          <>
                            <Link
                              href={`/plan/comida/${asignacion.id}`}
                              className="text-xs text-[var(--accent)] underline"
                            >
                              Ver lo guardado
                            </Link>
                            {asignacion.status === "CONFIRMED" && (
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() => run(() => consumePlannedMeal(asignacion.id))}
                                className="rounded-full border border-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent)] disabled:opacity-50"
                              >
                                Comimos lo planificado
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => run(() => unconfirmMeal(asignacion.id))}
                              className="text-xs text-[var(--ink)]/50 underline"
                            >
                              Deshacer confirmación
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => run(() => confirmMeal(asignacion.id))}
                            className="rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                          >
                            Confirmar y guardar porciones
                          </button>
                        )}
                        {asignacion.needsReview && (
                          <p className="w-full text-[11px] text-amber-800">
                            {asignacion.reviewReason ?? "Algo cambió alrededor de esta comida"}. Las
                            porciones guardadas quedaron como estaban: deshaz la confirmación si
                            quieres recalcularlas.
                          </p>
                        )}
                      </div>
                    )}

                    {abierto === clave && (
                      <div className="space-y-2 border-t border-[var(--ink)]/10 px-3 py-3">
                        <select
                          className={field}
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
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => run(() => clearAssignment(asignacion.id))}
                            className="w-full rounded-full border border-[var(--ink)]/20 px-4 py-2 text-sm"
                          >
                            Quitar de la semana
                          </button>
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
                    className="w-full rounded-xl border border-dashed border-[var(--ink)]/20 px-3 py-2 text-xs text-[var(--ink)]/60"
                  >
                    + Postre, snack, fruta u otra comida
                  </button>
                )}
            </div>
          </section>
        );
      })}

      <section className="rounded-2xl border border-dashed border-[var(--ink)]/20 bg-white p-4">
        {!eventoAbierto ? (
          <button
            type="button"
            onClick={() => setEventoAbierto(true)}
            className="w-full rounded-full border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)]"
          >
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
      </section>
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
    <div className="mt-2 space-y-2 rounded-xl bg-[var(--ink)]/5 p-3">
      <ul className="space-y-1">
        {members.map((m) => (
          <li key={m.id}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
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
        <p className="text-[11px] text-amber-800">
          Si no come nadie, mejor quita la comida de la semana.
        </p>
      )}
      <button
        type="button"
        disabled={pending || marcados.length === 0}
        onClick={() => onGuardar(todos ? [] : marcados)}
        className="w-full rounded-full bg-[var(--accent)] px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
      >
        Guardar quién come
      </button>
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

  const field = "w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2 text-base";

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Evento de la semana</h3>
      <p className="text-xs text-[var(--ink)]/60">
        Un asado, un cumpleaños o un viaje. Da margen ese día sin compensar en los otros: nadie
        &quot;paga&quot; una comida con un día de ayuno.
      </p>

      <input
        value={titulo}
        onChange={(e) => setTitulo(e.target.value)}
        placeholder="Asado en casa de mi hermana"
        className={field}
      />

      <div className="flex gap-2">
        <select value={fecha} onChange={(e) => setFecha(e.target.value)} className={field}>
          {dias.map((d) => (
            <option key={d} value={d}>
              {weekdayName(d)} {dayOfMonth(d)}
            </option>
          ))}
        </select>
        <select value={tipo} onChange={(e) => setTipo(e.target.value)} className={field}>
          {Object.entries(EVENT_LABELS).map(([valor, texto]) => (
            <option key={valor} value={valor}>
              {texto}
            </option>
          ))}
        </select>
      </div>

      <div className="flex gap-2">
        <select
          value={comida}
          onChange={(e) => setComida(e.target.value as MealType | "")}
          className={field}
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
          className={field}
        >
          {Object.entries(STRATEGY_LABELS).map(([valor, texto]) => (
            <option key={valor} value={valor}>
              {texto}
            </option>
          ))}
        </select>
      </div>

      <label className="block text-xs text-[var(--ink)]/60">
        Si dura varios días (un viaje), hasta cuándo
        <select
          value={hasta}
          onChange={(e) => setHasta(e.target.value)}
          className={`${field} mt-1`}
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
        <legend className="text-xs text-[var(--ink)]/60">
          ¿A quién afecta? Sin marcar a nadie, es de toda la familia.
        </legend>
        <ul className="mt-1 flex flex-wrap gap-2">
          {members.map((m) => (
            <li key={m.id}>
              <label className="flex items-center gap-1.5 rounded-full border border-[var(--ink)]/20 px-3 py-1.5 text-xs">
                <input
                  type="checkbox"
                  className="size-3.5"
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

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-full border border-[var(--ink)]/20 px-4 py-2 text-sm"
        >
          Cancelar
        </button>
        <button
          type="button"
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
          className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Guardar evento
        </button>
      </div>
    </div>
  );
}
