"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ADDED_FAT_LABELS,
  ADDED_FAT_STANCES,
  SALAD_PREFERENCE_LABELS,
  TRACKING_DESCRIPTIONS,
  TRACKING_LABELS,
  TRACKING_MODES,
  type AddedFatStance,
  type MemberNutritionProfile,
  type SaladPreference,
  type TrackingMode,
} from "@/domain/nutrition/types";
import { MEAL_TYPE_LABELS, type MealType } from "@/domain/recipes/types";
import { saveMealGoals, setAddedFatStance, setTrackingMode } from "../nutrition-actions";

const EDITABLE_MEALS: MealType[] = ["BREAKFAST", "LUNCH", "TEA", "DINNER"];

export function MemberNutritionEditor({
  memberId,
  memberName,
  profile,
}: {
  memberId: string;
  memberName: string;
  profile: MemberNutritionProfile;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openMeal, setOpenMeal] = useState<MealType | null>(null);

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

  const chip = "rounded-full px-3 py-1.5 text-xs font-medium";
  const on = `${chip} bg-[var(--accent)] text-white`;
  const off = `${chip} border border-[var(--ink)]/20 text-[var(--ink)]/70`;

  return (
    <div className="space-y-5">
      {/* ---- Alimentación / tracking ---- */}
      <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
          Alimentación
        </h2>
        <div className="mb-2 flex flex-wrap gap-2">
          {TRACKING_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={pending}
              className={profile.trackingMode === mode ? on : off}
              onClick={() => run(() => setTrackingMode(memberId, memberName, mode as TrackingMode))}
            >
              {TRACKING_LABELS[mode]}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--ink)]/60">
          {TRACKING_DESCRIPTIONS[profile.trackingMode]}
        </p>
      </section>

      {/* ---- Objetivos diarios ---- */}
      <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
          Objetivos del día
        </h2>
        {profile.trackingMode === "OFF" ? (
          <p className="text-sm text-[var(--ink)]/60">
            Sin seguimiento no se piden objetivos. Igual recibe su porción, su receta y su lugar en
            la planificación.
          </p>
        ) : Object.keys(profile.dailyTargets).length === 0 ? (
          <p className="text-sm text-[var(--ink)]/60">Todavía no hay objetivos diarios.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {Object.entries(profile.dailyTargets).map(([type, range]) => (
              <li key={type} className="flex justify-between">
                <span>{type === "PROTEIN_G" ? "Proteína" : type === "ENERGY_KCAL" ? "Energía" : type}</span>
                <span className="tabular-nums text-[var(--ink)]/70">
                  {range?.minimum !== null && range?.minimum !== undefined && `mín ${range.minimum} · `}
                  {range?.preferred !== null && range?.preferred !== undefined && `ideal ${range.preferred}`}
                  {range?.maximum !== null && range?.maximum !== undefined && ` · máx ${range.maximum}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- Mis comidas ---- */}
      <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
          Mis comidas
        </h2>
        {profile.pattern.usesFastingPattern && (
          <p className="mb-3 rounded-xl bg-[var(--ink)]/5 px-3 py-2 text-xs text-[var(--ink)]/70">
            Patrón con ayuno: la primera comida del día es{" "}
            <strong>
              {profile.pattern.firstMealType
                ? MEAL_TYPE_LABELS[profile.pattern.firstMealType]
                : "la que corresponda"}
            </strong>
            . Es una configuración elegida, no una recomendación médica.
          </p>
        )}

        <div className="space-y-2">
          {EDITABLE_MEALS.map((mealType) => {
            const slot = profile.pattern.meals.find((m) => m.mealType === mealType);
            const enabled = slot ? slot.availability !== "DISABLED" : true;
            const targets = profile.mealTargets[mealType];
            return (
              <div key={mealType} className="rounded-xl border border-[var(--ink)]/10">
                <button
                  type="button"
                  onClick={() => setOpenMeal(openMeal === mealType ? null : mealType)}
                  className="flex w-full items-center justify-between px-3 py-2.5 text-left"
                >
                  <span className="text-sm font-medium">
                    {MEAL_TYPE_LABELS[mealType]}
                    {slot?.isFirstMeal && (
                      <span className="ml-2 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] text-[var(--accent)]">
                        primera comida
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-[var(--ink)]/60">
                    {!enabled
                      ? "Desactivada"
                      : targets?.PROTEIN_G
                        ? `${targets.PROTEIN_G.minimum ?? "—"}–${targets.PROTEIN_G.maximum ?? "—"} g proteína`
                        : "Sin objetivos"}
                  </span>
                </button>

                {openMeal === mealType && (
                  <MealGoalForm
                    memberId={memberId}
                    memberName={memberName}
                    mealType={mealType}
                    enabled={enabled}
                    isFirstMeal={slot?.isFirstMeal ?? false}
                    saladPreference={slot?.saladPreference ?? "NEUTRAL"}
                    proteinMin={targets?.PROTEIN_G?.minimum ?? null}
                    proteinPreferred={targets?.PROTEIN_G?.preferred ?? null}
                    proteinMax={targets?.PROTEIN_G?.maximum ?? null}
                    energyMax={targets?.ENERGY_KCAL?.maximum ?? null}
                    pending={pending}
                    onSave={run}
                  />
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ---- Preparación ---- */}
      <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
          Preparación
        </h2>
        <p className="mb-2 text-xs text-[var(--ink)]/60">
          Freír no aporta lo mismo que air fryer sin aceite. Esa diferencia va en tu porción, no en
          la de los demás.
        </p>
        <div className="mb-3 flex flex-wrap gap-2">
          {ADDED_FAT_STANCES.map((stance) => (
            <button
              key={stance}
              type="button"
              disabled={pending}
              className={profile.addedFatStance === stance ? on : off}
              onClick={() =>
                run(() => setAddedFatStance(memberId, memberName, stance as AddedFatStance))
              }
            >
              {ADDED_FAT_LABELS[stance]}
            </button>
          ))}
        </div>

      </section>

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
    </div>
  );
}

function MealGoalForm({
  memberId,
  memberName,
  mealType,
  enabled,
  isFirstMeal,
  saladPreference,
  proteinMin,
  proteinPreferred,
  proteinMax,
  energyMax,
  pending,
  onSave,
}: {
  memberId: string;
  memberName: string;
  mealType: MealType;
  enabled: boolean;
  isFirstMeal: boolean;
  saladPreference: SaladPreference;
  proteinMin: number | null;
  proteinPreferred: number | null;
  proteinMax: number | null;
  energyMax: number | null;
  pending: boolean;
  onSave: (action: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const [form, setForm] = useState({
    enabled,
    isFirstMeal,
    saladPreference,
    proteinMin: proteinMin?.toString() ?? "",
    proteinPreferred: proteinPreferred?.toString() ?? "",
    proteinMax: proteinMax?.toString() ?? "",
    energyMax: energyMax?.toString() ?? "",
  });

  const field = "w-full rounded-xl border border-[var(--ink)]/20 px-3 py-2 text-base";
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  return (
    <div className="space-y-3 border-t border-[var(--ink)]/10 px-3 py-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        Como {MEAL_TYPE_LABELS[mealType].toLowerCase()}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.isFirstMeal}
          onChange={(e) => setForm({ ...form, isFirstMeal: e.target.checked })}
        />
        Es mi primera comida del día
      </label>

      <div>
        <p className="mb-1 text-xs font-medium text-[var(--ink)]/70">Proteína (g)</p>
        <div className="flex gap-2">
          {(["proteinMin", "proteinPreferred", "proteinMax"] as const).map((key, i) => (
            <div key={key} className="flex-1">
              <label className="mb-0.5 block text-[11px] text-[var(--ink)]/50">
                {["mínimo", "ideal", "máximo"][i]}
              </label>
              <input
                type="number"
                min={0}
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className={field}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-0.5 block text-xs font-medium text-[var(--ink)]/70">
          Máximo de calorías (kcal)
        </label>
        <input
          type="number"
          min={0}
          value={form.energyMax}
          onChange={(e) => setForm({ ...form, energyMax: e.target.value })}
          className={field}
        />
      </div>

      <div>
        <p className="mb-1 text-xs font-medium text-[var(--ink)]/70">Ensalada</p>
        <div className="flex gap-2">
          {(["PREFERRED", "NEUTRAL", "AVOID"] as SaladPreference[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setForm({ ...form, saladPreference: s })}
              className={`rounded-full px-3 py-2 text-xs ${
                form.saladPreference === s
                  ? "bg-[var(--accent)] text-white"
                  : "border border-[var(--ink)]/20 text-[var(--ink)]/70"
              }`}
            >
              {SALAD_PREFERENCE_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        disabled={pending}
        onClick={() =>
          onSave(() =>
            saveMealGoals(memberId, memberName, {
              mealType,
              proteinMin: num(form.proteinMin),
              proteinPreferred: num(form.proteinPreferred),
              proteinMax: num(form.proteinMax),
              energyMax: num(form.energyMax),
              saladPreference: form.saladPreference,
              enabled: form.enabled,
              isFirstMeal: form.isFirstMeal,
            }),
          )
        }
        className="w-full rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        Guardar
      </button>
    </div>
  );
}
