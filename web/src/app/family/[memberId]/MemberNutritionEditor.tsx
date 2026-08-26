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
import {
  Button,
  Card,
  Chip,
  DataRow,
  EmptyState,
  ErrorNote,
  Icon,
  Notice,
  Section,
} from "@/components/ui";
import { saveMealGoals, setAddedFatStance, setTrackingMode } from "../nutrition-actions";

const EDITABLE_MEALS: MealType[] = ["BREAKFAST", "LUNCH", "TEA", "DINNER"];

/** Campo de formulario del kit: mismo alto de toque en todas las pantallas. */
const FIELD =
  "min-h-[48px] w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";

/**
 * Chip que se ELIGE. No es el `Chip` del kit —ese solo informa—: este se toca,
 * así que lleva área de toque completa y `aria-pressed` para que el estado
 * llegue también a quien no ve el color.
 */
function OpcionChip({
  activa,
  disabled,
  onClick,
  children,
}: {
  activa: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={activa}
      onClick={onClick}
      className={`min-h-[44px] rounded-full px-md py-sm font-body-sm text-body-sm font-semibold transition-transform active:scale-95 disabled:opacity-40 ${
        activa
          ? "bg-primary text-on-primary"
          : "border border-outline-variant text-on-surface-variant"
      }`}
    >
      {children}
    </button>
  );
}

/** Confirmación de guardado. Lo que FALLA se muestra con `ErrorNote`. */
function AvisoOk({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-sm rounded-2xl bg-primary-fixed px-md py-sm font-body-sm text-body-sm text-on-primary-fixed">
      <Icon name="check_circle" className="mt-0.5 shrink-0 text-[18px]" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

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

  return (
    <div>
      {/* ---- Alimentación / tracking ---- */}
      <Section title="Alimentación">
        <Card className="space-y-sm p-md">
          <div className="flex flex-wrap gap-sm">
            {TRACKING_MODES.map((mode) => (
              <OpcionChip
                key={mode}
                activa={profile.trackingMode === mode}
                disabled={pending}
                onClick={() => run(() => setTrackingMode(memberId, memberName, mode as TrackingMode))}
              >
                {TRACKING_LABELS[mode]}
              </OpcionChip>
            ))}
          </div>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            {TRACKING_DESCRIPTIONS[profile.trackingMode]}
          </p>
        </Card>
      </Section>

      {/* ---- Objetivos diarios ---- */}
      <Section title="Objetivos del día">
        {profile.trackingMode === "OFF" ? (
          <EmptyState icon="monitor_heart">
            Sin seguimiento no se piden objetivos. Igual recibe su porción, su receta y su lugar en
            la planificación.
          </EmptyState>
        ) : Object.keys(profile.dailyTargets).length === 0 ? (
          <EmptyState icon="flag">Todavía no hay objetivos diarios.</EmptyState>
        ) : (
          <Card className="px-md py-xs">
            {Object.entries(profile.dailyTargets).map(([type, range]) => (
              <DataRow
                key={type}
                label={
                  type === "PROTEIN_G" ? "Proteína" : type === "ENERGY_KCAL" ? "Energía" : type
                }
              >
                <span className="tabular-nums">
                  {range?.minimum !== null &&
                    range?.minimum !== undefined &&
                    `mín ${range.minimum} · `}
                  {range?.preferred !== null &&
                    range?.preferred !== undefined &&
                    `ideal ${range.preferred}`}
                  {range?.maximum !== null &&
                    range?.maximum !== undefined &&
                    ` · máx ${range.maximum}`}
                </span>
              </DataRow>
            ))}
          </Card>
        )}
      </Section>

      {/* ---- Mis comidas ---- */}
      <Section title="Mis comidas">
        {profile.pattern.usesFastingPattern && (
          <div className="mb-sm">
            <Notice icon="schedule">
              Patrón con ayuno: la primera comida del día es{" "}
              <strong className="font-semibold">
                {profile.pattern.firstMealType
                  ? MEAL_TYPE_LABELS[profile.pattern.firstMealType]
                  : "la que corresponda"}
              </strong>
              . Es una configuración elegida, no una recomendación médica.
            </Notice>
          </div>
        )}

        <ul className="space-y-sm">
          {EDITABLE_MEALS.map((mealType) => {
            const slot = profile.pattern.meals.find((m) => m.mealType === mealType);
            const enabled = slot ? slot.availability !== "DISABLED" : true;
            const targets = profile.mealTargets[mealType];
            const abierta = openMeal === mealType;
            return (
              <Card key={mealType} as="li" className="overflow-hidden">
                <button
                  type="button"
                  aria-expanded={abierta}
                  onClick={() => setOpenMeal(abierta ? null : mealType)}
                  className="flex min-h-[56px] w-full items-center justify-between gap-md px-md py-sm text-left"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-sm">
                    <span className="font-body-md text-body-md font-semibold text-on-surface">
                      {MEAL_TYPE_LABELS[mealType]}
                    </span>
                    {slot?.isFirstMeal && (
                      <Chip tono="primario" icon="schedule">
                        primera comida
                      </Chip>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-xs text-on-surface-variant">
                    <span className="font-body-sm text-body-sm">
                      {!enabled
                        ? "Desactivada"
                        : targets?.PROTEIN_G
                          ? `${targets.PROTEIN_G.minimum ?? "—"}–${targets.PROTEIN_G.maximum ?? "—"} g proteína`
                          : "Sin objetivos"}
                    </span>
                    <Icon name={abierta ? "expand_less" : "expand_more"} />
                  </span>
                </button>

                {abierta && (
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
              </Card>
            );
          })}
        </ul>
      </Section>

      {/* ---- Preparación ---- */}
      <Section
        title="Preparación"
        hint="Freír no aporta lo mismo que air fryer sin aceite. Esa diferencia va en tu porción, no en la de los demás."
      >
        <Card className="p-md">
          <div className="flex flex-wrap gap-sm">
            {ADDED_FAT_STANCES.map((stance) => (
              <OpcionChip
                key={stance}
                activa={profile.addedFatStance === stance}
                disabled={pending}
                onClick={() =>
                  run(() => setAddedFatStance(memberId, memberName, stance as AddedFatStance))
                }
              >
                {ADDED_FAT_LABELS[stance]}
              </OpcionChip>
            ))}
          </div>
        </Card>
      </Section>

      {message && <AvisoOk>{message}</AvisoOk>}
      {error && <ErrorNote>{error}</ErrorNote>}
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

  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  return (
    <div className="space-y-md border-t border-outline-variant/40 px-md py-md">
      <label className="flex items-center gap-sm font-body-md text-body-md text-on-surface">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          className="h-5 w-5 shrink-0 accent-primary"
        />
        Como {MEAL_TYPE_LABELS[mealType].toLowerCase()}
      </label>
      <label className="flex items-center gap-sm font-body-md text-body-md text-on-surface">
        <input
          type="checkbox"
          checked={form.isFirstMeal}
          onChange={(e) => setForm({ ...form, isFirstMeal: e.target.checked })}
          className="h-5 w-5 shrink-0 accent-primary"
        />
        Es mi primera comida del día
      </label>

      <div>
        <p className="mb-xs font-label-md text-label-md text-on-surface-variant">Proteína (g)</p>
        <div className="grid grid-cols-3 gap-sm">
          {(["proteinMin", "proteinPreferred", "proteinMax"] as const).map((key, i) => (
            <label key={key} className="min-w-0">
              <span className="mb-0.5 block font-label-md text-label-md text-on-surface-variant">
                {["mínimo", "ideal", "máximo"][i]}
              </span>
              <input
                type="number"
                min={0}
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className={FIELD}
              />
            </label>
          ))}
        </div>
      </div>

      <label className="block">
        <span className="mb-xs block font-label-md text-label-md text-on-surface-variant">
          Máximo de calorías (kcal)
        </span>
        <input
          type="number"
          min={0}
          value={form.energyMax}
          onChange={(e) => setForm({ ...form, energyMax: e.target.value })}
          className={FIELD}
        />
      </label>

      <div>
        <p className="mb-xs font-label-md text-label-md text-on-surface-variant">Ensalada</p>
        <div className="flex flex-wrap gap-sm">
          {(["PREFERRED", "NEUTRAL", "AVOID"] as SaladPreference[]).map((s) => (
            <OpcionChip
              key={s}
              activa={form.saladPreference === s}
              onClick={() => setForm({ ...form, saladPreference: s })}
            >
              {SALAD_PREFERENCE_LABELS[s]}
            </OpcionChip>
          ))}
        </div>
      </div>

      <Button
        full
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
      >
        Guardar
      </Button>
    </div>
  );
}
