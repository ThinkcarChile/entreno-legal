"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addDays, formatDate } from "@/domain/nutrition/calendar";
import { MEAL_TYPE_LABELS, type MealType } from "@/domain/recipes/types";
import {
  Button,
  ButtonOutline,
  Card,
  ErrorNote,
  Icon,
  Notice,
  Section,
} from "@/components/ui";
import { clearDailyOverride, saveDailyOverride } from "../nutrition-actions";

/** Campo de formulario del kit: mismo alto de toque en todas las pantallas. */
const FIELD =
  "min-h-[48px] w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";

/**
 * Chip que se ELIGE. No es el `Chip` del kit —ese solo informa—: este se toca,
 * así que lleva área de toque completa y `aria-pressed`.
 */
function OpcionChip({
  activa,
  onClick,
  children,
}: {
  activa: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={activa}
      onClick={onClick}
      className={`min-h-[44px] rounded-full px-md py-sm font-body-sm text-body-sm font-semibold transition-transform active:scale-95 ${
        activa
          ? "bg-primary text-on-primary"
          : "border border-outline-variant text-on-surface-variant"
      }`}
    >
      {children}
    </button>
  );
}

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

  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  return (
    <Section
      title="Excepciones de un día"
      hint="Para el asado del sábado o el día que se come distinto. Cambia solo esa fecha; tu patrón habitual queda igual."
    >
      {existing.length > 0 && (
        <ul className="mb-sm space-y-sm">
          {existing.map((plan) => (
            <Card key={plan.date} as="li" className="p-md">
              <p className="font-body-md text-body-md font-semibold capitalize text-on-surface">
                {formatDate(plan.date)}
              </p>
              <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">
                Solo este día ·{" "}
                {plan.meals
                  .map(
                    (m) =>
                      `${MEAL_TYPE_LABELS[m.mealType]}${m.energyMax ? ` máx ${m.energyMax} kcal` : ""}`,
                  )
                  .join(", ")}
              </p>
              <div className="mt-sm">
                <ButtonOutline
                  disabled={pending}
                  onClick={() => run(() => clearDailyOverride(memberId, plan.date))}
                >
                  <Icon name="undo" className="text-[18px]" />
                  Volver al patrón habitual
                </ButtonOutline>
              </div>
            </Card>
          ))}
        </ul>
      )}

      {!abierto ? (
        <ButtonOutline className="w-full" onClick={() => setAbierto(true)}>
          <Icon name="edit_calendar" className="text-[18px]" />
          Modificar solo un día
        </ButtonOutline>
      ) : (
        <Card className="space-y-md p-md">
          <label className="block" htmlFor="fecha">
            <span className="mb-xs block font-label-md text-label-md text-on-surface-variant">
              Fecha
            </span>
            <input
              id="fecha"
              type="date"
              min={today}
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              className={FIELD}
            />
          </label>

          <div>
            <p className="mb-xs font-label-md text-label-md text-on-surface-variant">Comida</p>
            <div className="flex flex-wrap gap-sm">
              {(["BREAKFAST", "LUNCH", "TEA", "DINNER"] as MealType[]).map((m) => (
                <OpcionChip key={m} activa={comida === m} onClick={() => setComida(m)}>
                  {MEAL_TYPE_LABELS[m]}
                </OpcionChip>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-sm font-body-md text-body-md text-on-surface">
            <input
              type="checkbox"
              checked={habilitada}
              onChange={(e) => setHabilitada(e.target.checked)}
              className="h-5 w-5 shrink-0 accent-primary"
            />
            Ese día sí como {MEAL_TYPE_LABELS[comida].toLowerCase()}
          </label>

          <label className="block" htmlFor="kcalDia">
            <span className="mb-xs block font-label-md text-label-md text-on-surface-variant">
              Máximo de calorías solo ese día
            </span>
            <input
              id="kcalDia"
              type="number"
              min={0}
              placeholder="1000"
              value={energyMax}
              onChange={(e) => setEnergyMax(e.target.value)}
              className={`${FIELD} placeholder:text-outline`}
            />
          </label>

          <div>
            <p className="mb-xs font-label-md text-label-md text-on-surface-variant">
              Proteína solo ese día (g)
            </p>
            <div className="grid grid-cols-3 gap-sm">
              {(
                [
                  ["mínimo", proteinMin, setProteinMin],
                  ["ideal", proteinPreferred, setProteinPreferred],
                  ["máximo", proteinMax, setProteinMax],
                ] as const
              ).map(([etiqueta, valor, setter]) => (
                <label key={etiqueta} className="min-w-0">
                  <span className="mb-0.5 block font-label-md text-label-md text-on-surface-variant">
                    {etiqueta}
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={valor}
                    onChange={(e) => setter(e.target.value)}
                    className={FIELD}
                  />
                </label>
              ))}
            </div>
          </div>

          <Notice icon="event">
            Solo para el{" "}
            <strong className="font-semibold capitalize">{formatDate(fecha)}</strong>. Tu patrón
            habitual no cambia.
          </Notice>

          <div className="flex flex-wrap gap-sm">
            <ButtonOutline className="flex-1" onClick={() => setAbierto(false)}>
              Cancelar
            </ButtonOutline>
            <Button
              className="flex-1"
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
            >
              Guardar
            </Button>
          </div>
        </Card>
      )}

      {message && (
        <p className="mt-sm flex items-start gap-sm rounded-2xl bg-primary-fixed px-md py-sm font-body-sm text-body-sm text-on-primary-fixed">
          <Icon name="check_circle" className="mt-0.5 shrink-0 text-[18px]" />
          <span className="min-w-0">{message}</span>
        </p>
      )}
      {error && (
        <div className="mt-sm">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Section>
  );
}
