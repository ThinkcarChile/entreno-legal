"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addDays, formatDate } from "@/domain/nutrition/calendar";
import { MEAL_TYPE_LABELS, type MealType } from "@/domain/recipes/types";
import { clearDailyOverride, saveDailyOverride } from "../nutrition-actions";

/**
 * QA §28 — "Modificar solo un día".
 *
 * La excepción NO toca el patrón habitual: se guarda aparte, se muestra con la
 * fecha a la vista, y se puede deshacer volviendo al patrón de siempre.
 */
export function DailyOverrideEditor({
  memberId,
  today,
  existing,
}: {
  memberId: string;
  /** Fecha de hoy EN LA ZONA DEL HOGAR, no en UTC. */
  today: string;
  existing: { date: string; meals: { mealType: MealType; energyMax: number | null }[] }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [abierto, setAbierto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [fecha, setFecha] = useState(addDays(today, 1));
  const [comida, setComida] = useState<MealType>("LUNCH");
  const [habilitada, setHabilitada] = useState(true);
  const [energyMax, setEnergyMax] = useState("");
  const [proteinMin, setProteinMin] = useState("");
  const [proteinPreferred, setProteinPreferred] = useState("");
  const [proteinMax, setProteinMax] = useState("");

  function run(action: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "No se pudo guardar.");
        return;
      }
      setMessage(result.message ?? "Guardado.");
      router.refresh();
    });
  }

  const field = "w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2 text-base";
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  return (
    <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
        Excepciones de un día
      </h2>
      <p className="mb-3 text-xs text-[var(--ink)]/60">
        Para el asado del sábado o el día que se come distinto. Cambia solo esa fecha; tu patrón
        habitual queda igual.
      </p>

      {existing.length > 0 && (
        <ul className="mb-4 space-y-1.5">
          {existing.map((plan) => (
            <li
              key={plan.date}
              className="flex items-center justify-between gap-3 rounded-xl bg-[var(--paper)] px-3 py-2 text-sm"
            >
              <span>
                <strong className="capitalize">{formatDate(plan.date)}</strong>
                <span className="ml-2 text-[11px] text-[var(--ink)]/60">
                  Solo este día ·{" "}
                  {plan.meals
                    .map(
                      (m) =>
                        `${MEAL_TYPE_LABELS[m.mealType]}${m.energyMax ? ` máx ${m.energyMax} kcal` : ""}`,
                    )
                    .join(", ")}
                </span>
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => clearDailyOverride(memberId, plan.date))}
                className="shrink-0 text-xs text-[var(--ink)]/50 underline"
              >
                Volver al patrón habitual
              </button>
            </li>
          ))}
        </ul>
      )}

      {!abierto ? (
        <button
          type="button"
          onClick={() => setAbierto(true)}
          className="w-full rounded-full border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)]"
        >
          Modificar solo un día
        </button>
      ) : (
        <div className="space-y-3">
          <div>
            <label htmlFor="fecha" className="mb-1 block text-xs font-medium text-[var(--ink)]/70">
              Fecha
            </label>
            <input
              id="fecha"
              type="date"
              min={today}
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-[var(--ink)]/70">Comida</p>
            <div className="flex flex-wrap gap-2">
              {(["BREAKFAST", "LUNCH", "TEA", "DINNER"] as MealType[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setComida(m)}
                  className={`rounded-full px-3 py-2 text-xs font-medium ${
                    comida === m
                      ? "bg-[var(--accent)] text-white"
                      : "border border-[var(--ink)]/20 text-[var(--ink)]/70"
                  }`}
                >
                  {MEAL_TYPE_LABELS[m]}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={habilitada}
              onChange={(e) => setHabilitada(e.target.checked)}
            />
            Ese día sí como {MEAL_TYPE_LABELS[comida].toLowerCase()}
          </label>

          <div>
            <label htmlFor="kcalDia" className="mb-1 block text-xs font-medium text-[var(--ink)]/70">
              Máximo de calorías solo ese día
            </label>
            <input
              id="kcalDia"
              type="number"
              min={0}
              placeholder="1000"
              value={energyMax}
              onChange={(e) => setEnergyMax(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-[var(--ink)]/70">Proteína solo ese día (g)</p>
            <div className="flex gap-2">
              {(
                [
                  ["mínimo", proteinMin, setProteinMin],
                  ["ideal", proteinPreferred, setProteinPreferred],
                  ["máximo", proteinMax, setProteinMax],
                ] as const
              ).map(([etiqueta, valor, setter]) => (
                <div key={etiqueta} className="flex-1">
                  <label className="mb-0.5 block text-[11px] text-[var(--ink)]/50">{etiqueta}</label>
                  <input
                    type="number"
                    min={0}
                    value={valor}
                    onChange={(e) => setter(e.target.value)}
                    className={field}
                  />
                </div>
              ))}
            </div>
          </div>

          <p className="rounded-xl bg-[var(--ink)]/5 px-3 py-2 text-xs text-[var(--ink)]/70">
            Solo para el <strong className="capitalize">{formatDate(fecha)}</strong>. Tu patrón
            habitual no cambia.
          </p>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setAbierto(false)}
              className="flex-1 rounded-full border border-[var(--ink)]/20 px-4 py-2 text-sm"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const r = await saveDailyOverride(memberId, {
                    date: fecha,
                    mealType: comida,
                    enabled: habilitada,
                    energyMax: num(energyMax),
                    proteinMin: num(proteinMin),
                    proteinPreferred: num(proteinPreferred),
                    proteinMax: num(proteinMax),
                  });
                  if (r.ok) setAbierto(false);
                  return r;
                })
              }
              className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Guardar
            </button>
          </div>
        </div>
      )}

      {message && <p className="mt-2 text-xs text-[var(--accent)]">{message}</p>}
      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
