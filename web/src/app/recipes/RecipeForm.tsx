"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { NutritionPanel } from "@/components/NutritionPanel";
import { WEIGHT_BASIS_LABELS, type WeightBasis } from "@/domain/catalog/types";
import { calculateMealNutrition } from "@/domain/recipes/nutrition";
import {
  COOKING_METHODS,
  COOKING_METHOD_LABELS,
  MEAL_TYPES,
  MEAL_TYPE_LABELS,
  SLOT_ADD_LABELS,
  SLOT_LABELS,
  type MealType,
  type RecipeComponent,
  type SlotType,
  type TemplateKind,
} from "@/domain/recipes/types";
import type { RecipeDraftInput } from "@/domain/recipes/schemas";
import type { IngredientOption } from "./queries";
import { createRecipe, publishVersion, saveDraft } from "./actions";

/**
 * Crear una receta no debe sentirse como editar una base de datos (§33): se
 * habla de "Agregar proteína", no de insertar un meal_slot_component. La
 * nutrición se actualiza mientras se escribe.
 */

const BASES: WeightBasis[] = ["RAW", "COOKED", "DRAINED", "EDIBLE_PORTION", "AS_PACKAGED"];

/** Slots que se ofrecen para armar: los de uso corriente primero. */
const OFFERED_SLOTS: SlotType[] = [
  "PROTEIN",
  "CARBOHYDRATE",
  "VEGETABLE",
  "SALAD",
  "FAT",
  "SAUCE",
  "FRUIT",
  "BASE",
  "TOPPING",
  "SWEETENER",
];

interface DraftComponent {
  key: string;
  ingredientId: string;
  quantity: string;
  weightBasis: WeightBasis;
  cookingMethod: string;
  isOptional: boolean;
}

interface DraftSlot {
  key: string;
  slotType: SlotType;
  isRequired: boolean;
  components: DraftComponent[];
}

interface DraftStep {
  key: string;
  instruction: string;
  durationMinutes: string;
}

export interface RecipeFormInitial {
  templateId: string;
  versionId: string;
  name: string;
  description: string | null;
  kind: TemplateKind;
  mealTypes: MealType[];
  baseServings: number;
  baseTimeMinutes: number | null;
  slots: DraftSlot[];
  steps: DraftStep[];
}

let counter = 0;
const nextKey = () => `k${(counter += 1)}`;

export function RecipeForm({
  ingredients,
  initial,
}: {
  ingredients: IngredientOption[];
  initial?: RecipeFormInitial;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<TemplateKind>(initial?.kind ?? "MEAL");
  const [mealTypes, setMealTypes] = useState<MealType[]>(initial?.mealTypes ?? ["LUNCH"]);
  const [baseServings, setBaseServings] = useState(String(initial?.baseServings ?? 4));
  const [baseTime, setBaseTime] = useState(String(initial?.baseTimeMinutes ?? ""));
  const [slots, setSlots] = useState<DraftSlot[]>(initial?.slots ?? []);
  const [steps, setSteps] = useState<DraftStep[]>(initial?.steps ?? []);

  const byId = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);

  /** Ficha que corresponde al alimento en el estado elegido. */
  function factFor(ingredientId: string, basis: WeightBasis) {
    return byId.get(ingredientId)?.facts.find((f) => f.weightBasis === basis) ?? null;
  }

  /** Componentes en forma de dominio, para calcular la nutrición en vivo. */
  const liveComponents = useMemo<RecipeComponent[]>(() => {
    const result: RecipeComponent[] = [];
    for (const slot of slots) {
      for (const component of slot.components) {
        const quantity = Number(component.quantity);
        if (!component.ingredientId || !Number.isFinite(quantity) || quantity <= 0) continue;
        const fact = factFor(component.ingredientId, component.weightBasis);
        result.push({
          id: component.key,
          slotId: slot.key,
          slotType: slot.slotType,
          label: byId.get(component.ingredientId)?.name ?? "",
          target: { kind: "INGREDIENT", ingredientId: component.ingredientId },
          quantity,
          unit: fact?.basisUnit ?? "G",
          weightBasis: component.weightBasis,
          nutrition: fact
            ? { values: fact.values, weightBasis: fact.weightBasis, basisUnit: fact.basisUnit }
            : null,
          cookingMethod: null,
          yieldFactor: null,
          isOptional: component.isOptional,
          sortOrder: 1,
          adjustability: component.isOptional ? "OPTIONAL" : "ADJUSTABLE",
          role: "MAIN",
          minQuantity: null,
          maxQuantity: null,
          categoryId: null,
        });
      }
    }
    // factFor solo lee byId, que ya está en las dependencias.
    return result;
  }, [slots, byId]);

  const servingsNumber = Number(baseServings);
  const nutrition = useMemo(() => {
    if (!Number.isInteger(servingsNumber) || servingsNumber <= 0) return null;
    if (liveComponents.length === 0) return null;
    try {
      return calculateMealNutrition(liveComponents, servingsNumber);
    } catch {
      return null;
    }
  }, [liveComponents, servingsNumber]);

  function addSlot(slotType: SlotType) {
    setSlots((current) => [
      ...current,
      {
        key: nextKey(),
        slotType,
        isRequired: slotType !== "FAT" && slotType !== "SAUCE" && slotType !== "TOPPING",
        components: [
          {
            key: nextKey(),
            ingredientId: "",
            quantity: "",
            weightBasis: "RAW",
            cookingMethod: "",
            isOptional: false,
          },
        ],
      },
    ]);
  }

  function updateComponent(slotKey: string, key: string, patch: Partial<DraftComponent>) {
    setSlots((current) =>
      current.map((slot) =>
        slot.key !== slotKey
          ? slot
          : {
              ...slot,
              components: slot.components.map((c) => (c.key === key ? { ...c, ...patch } : c)),
            },
      ),
    );
  }

  function buildDraft(): RecipeDraftInput {
    return {
      name: name.trim(),
      description: initial?.description ?? null,
      kind,
      mealTypes,
      baseServings: Number(baseServings),
      baseTimeMinutes: baseTime ? Number(baseTime) : null,
      totalYieldFactor: null,
      slots: slots.map((slot) => ({
        slotType: slot.slotType,
        label: null,
        isRequired: slot.isRequired,
        components: slot.components
          .filter((c) => c.ingredientId && Number(c.quantity) > 0)
          .map((c) => {
            const fact = factFor(c.ingredientId, c.weightBasis);
            return {
              ingredientId: c.ingredientId,
              productId: null,
              nestedVersionId: null,
              quantity: Number(c.quantity),
              unit: fact?.basisUnit ?? ("G" as const),
              weightBasis: c.weightBasis,
              nutritionFactId: fact?.id ?? null,
              cookingMethod: (c.cookingMethod || null) as RecipeDraftInput["slots"][number]["components"][number]["cookingMethod"],
              yieldFactor: null,
              isOptional: c.isOptional,
            };
          }),
        alternatives: [],
      })),
      steps: steps
        .filter((s) => s.instruction.trim())
        .map((s) => ({
          instruction: s.instruction.trim(),
          durationMinutes: s.durationMinutes ? Number(s.durationMinutes) : null,
        })),
    };
  }

  function submit(publish: boolean) {
    setError(null);
    startTransition(async () => {
      const draft = buildDraft();
      const result = initial
        ? await saveDraft(initial.versionId, draft)
        : await createRecipe(draft);

      if (!result.ok) {
        setError(result.error ?? "No se pudo guardar.");
        return;
      }

      const templateId = result.templateId ?? initial?.templateId;
      const versionId = result.versionId ?? initial?.versionId;

      if (publish && templateId && versionId) {
        const published = await publishVersion(templateId, versionId);
        if (!published.ok) {
          setError(published.error ?? "Se guardó el borrador, pero no se pudo publicar.");
          router.push(`/recipes/${templateId}`);
          return;
        }
      }
      router.push(templateId ? `/recipes/${templateId}` : "/recipes");
      router.refresh();
    });
  }

  const field =
    "w-full rounded-xl border border-[var(--ink)]/20 bg-white px-3 py-2 text-base";
  const chip = "rounded-full px-3 py-2 text-xs font-medium";

  return (
    <div className="space-y-5 pb-28">
      <section className="space-y-3 rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium">
            ¿Cómo se llama?
          </label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Pollo con arroz y ensalada"
            className={field}
          />
        </div>

        <div>
          <p className="mb-1 text-sm font-medium">¿Cuándo se come?</p>
          <div className="flex flex-wrap gap-2">
            {MEAL_TYPES.filter((t) => t !== "OTHER").map((type) => {
              const on = mealTypes.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() =>
                    setMealTypes((current) =>
                      on ? current.filter((t) => t !== type) : [...current, type],
                    )
                  }
                  className={`${chip} ${
                    on
                      ? "bg-[var(--accent)] text-white"
                      : "border border-[var(--ink)]/20 text-[var(--ink)]/70"
                  }`}
                >
                  {MEAL_TYPE_LABELS[type]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <label htmlFor="servings" className="mb-1 block text-sm font-medium">
              ¿Para cuántas personas?
            </label>
            <input
              id="servings"
              type="number"
              min={1}
              max={50}
              value={baseServings}
              onChange={(e) => setBaseServings(e.target.value)}
              className={field}
            />
            <p className="mt-1 text-[11px] text-[var(--ink)]/50">
              Las cantidades que anotes son de la olla completa para esta cantidad de gente.
            </p>
          </div>
          <div className="w-28">
            <label htmlFor="time" className="mb-1 block text-sm font-medium">
              Minutos
            </label>
            <input
              id="time"
              type="number"
              min={1}
              value={baseTime}
              onChange={(e) => setBaseTime(e.target.value)}
              className={field}
            />
          </div>
        </div>

        <div>
          <p className="mb-1 text-sm font-medium">Tipo</p>
          <div className="flex gap-2">
            {(["MEAL", "SALAD", "DESSERT"] as TemplateKind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`${chip} ${
                  kind === k
                    ? "bg-[var(--accent)] text-white"
                    : "border border-[var(--ink)]/20 text-[var(--ink)]/70"
                }`}
              >
                {k === "MEAL" ? "Plato" : k === "SALAD" ? "Ensalada" : "Postre"}
              </button>
            ))}
          </div>
        </div>
      </section>

      {slots.map((slot) => (
        <section key={slot.key} className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">{SLOT_LABELS[slot.slotType]}</h3>
            <button
              type="button"
              onClick={() => setSlots((c) => c.filter((s) => s.key !== slot.key))}
              className="text-xs text-[var(--ink)]/50 underline"
            >
              Quitar
            </button>
          </div>

          <div className="space-y-3">
            {slot.components.map((component) => (
              <div key={component.key} className="space-y-2 rounded-xl bg-[var(--paper)] p-3">
                <select
                  value={component.ingredientId}
                  onChange={(e) =>
                    updateComponent(slot.key, component.key, { ingredientId: e.target.value })
                  }
                  className={field}
                >
                  <option value="">Elegir alimento…</option>
                  {ingredients.map((ingredient) => (
                    <option key={ingredient.id} value={ingredient.id}>
                      {ingredient.name}
                    </option>
                  ))}
                </select>

                <div className="flex gap-2">
                  <input
                    type="number"
                    min={0}
                    step="any"
                    placeholder="Gramos"
                    value={component.quantity}
                    onChange={(e) =>
                      updateComponent(slot.key, component.key, { quantity: e.target.value })
                    }
                    className={`${field} flex-1`}
                  />
                  <select
                    value={component.weightBasis}
                    onChange={(e) =>
                      updateComponent(slot.key, component.key, {
                        weightBasis: e.target.value as WeightBasis,
                      })
                    }
                    className={`${field} flex-1`}
                  >
                    {BASES.map((basis) => {
                      const available =
                        !component.ingredientId || Boolean(factFor(component.ingredientId, basis));
                      return (
                        <option key={basis} value={basis} disabled={!available}>
                          {WEIGHT_BASIS_LABELS[basis]}
                          {!available && " (sin datos)"}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div className="flex items-center gap-3">
                  <select
                    value={component.cookingMethod}
                    onChange={(e) =>
                      updateComponent(slot.key, component.key, { cookingMethod: e.target.value })
                    }
                    className={`${field} flex-1`}
                  >
                    <option value="">Sin método</option>
                    {COOKING_METHODS.map((method) => (
                      <option key={method} value={method}>
                        {COOKING_METHOD_LABELS[method]}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={component.isOptional}
                      onChange={(e) =>
                        updateComponent(slot.key, component.key, { isOptional: e.target.checked })
                      }
                    />
                    Opcional
                  </label>
                  {slot.components.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setSlots((current) =>
                          current.map((s) =>
                            s.key !== slot.key
                              ? s
                              : {
                                  ...s,
                                  components: s.components.filter((c) => c.key !== component.key),
                                },
                          ),
                        )
                      }
                      className="text-xs text-[var(--ink)]/50 underline"
                    >
                      Quitar
                    </button>
                  )}
                </div>

                {component.ingredientId &&
                  byId.get(component.ingredientId)?.facts.length === 0 && (
                    <p className="text-[11px] text-amber-700">
                      Este alimento no tiene datos nutricionales: el plato quedará con cálculo
                      incompleto.
                    </p>
                  )}
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() =>
              setSlots((current) =>
                current.map((s) =>
                  s.key !== slot.key
                    ? s
                    : {
                        ...s,
                        components: [
                          ...s.components,
                          {
                            key: nextKey(),
                            ingredientId: "",
                            quantity: "",
                            weightBasis: "RAW" as WeightBasis,
                            cookingMethod: "",
                            isOptional: false,
                          },
                        ],
                      },
                ),
              )
            }
            className="mt-3 text-sm text-[var(--accent)] underline"
          >
            Agregar otro alimento a {SLOT_LABELS[slot.slotType].toLowerCase()}
          </button>
        </section>
      ))}

      <section>
        <p className="mb-2 text-sm font-medium">¿Qué lleva el plato?</p>
        <div className="flex flex-wrap gap-2">
          {OFFERED_SLOTS.map((slotType) => (
            <button
              key={slotType}
              type="button"
              onClick={() => addSlot(slotType)}
              className="rounded-full border border-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent)]"
            >
              {SLOT_ADD_LABELS[slotType]}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
        <h3 className="mb-2 text-sm font-medium">Preparación</h3>
        <div className="space-y-2">
          {steps.map((step, index) => (
            <div key={step.key} className="flex gap-2">
              <span className="mt-2 w-5 shrink-0 text-xs text-[var(--ink)]/50">{index + 1}.</span>
              <textarea
                value={step.instruction}
                onChange={(e) =>
                  setSteps((current) =>
                    current.map((s) =>
                      s.key === step.key ? { ...s, instruction: e.target.value } : s,
                    ),
                  )
                }
                rows={2}
                placeholder="Hornear el pollo 25 minutos a 200 °C"
                className={`${field} flex-1`}
              />
              <input
                type="number"
                min={1}
                placeholder="min"
                value={step.durationMinutes}
                onChange={(e) =>
                  setSteps((current) =>
                    current.map((s) =>
                      s.key === step.key ? { ...s, durationMinutes: e.target.value } : s,
                    ),
                  )
                }
                className={`${field} w-20`}
              />
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() =>
            setSteps((current) => [
              ...current,
              { key: nextKey(), instruction: "", durationMinutes: "" },
            ])
          }
          className="mt-3 text-sm text-[var(--accent)] underline"
        >
          Agregar paso
        </button>
      </section>

      {nutrition && (
        <div className="space-y-3">
          <NutritionPanel title="Así va el plato completo" nutrition={nutrition.total} />
          <NutritionPanel title="Por porción" nutrition={nutrition.perServing} compact />
        </div>
      )}

      {error && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <div className="fixed inset-x-0 bottom-0 border-t border-[var(--ink)]/10 bg-[var(--paper)] px-4 py-3">
        <div className="mx-auto flex max-w-3xl gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => submit(false)}
            className="flex-1 rounded-full border border-[var(--ink)]/20 px-4 py-2.5 text-sm font-medium disabled:opacity-50"
          >
            Guardar borrador
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => submit(true)}
            className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Publicar
          </button>
        </div>
      </div>
    </div>
  );
}
