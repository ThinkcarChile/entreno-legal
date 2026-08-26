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
import { Button, ButtonOutline, Card, ErrorNote, Icon, Notice, Section } from "@/components/ui";
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

/** Campo de formulario del kit: mismo alto de toque en todas las pantallas. */
const FIELD =
  "min-h-[48px] w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm font-body-md text-body-md text-on-surface";

/** Etiqueta de campo del kit. */
const LABEL = "mb-xs block font-label-md text-label-md text-on-surface-variant";

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

/** Botón de quitar: icono con área de toque completa y nombre accesible. */
function BotonQuitar({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-transform active:scale-90"
    >
      <Icon name="close" className="text-[18px]" />
    </button>
  );
}

/** Enlace de acción dentro de una tarjeta (agregar alimento, paso, alternativa). */
function BotonAgregar({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-[44px] items-center gap-xs rounded-full px-md py-sm font-body-sm text-body-sm font-semibold text-primary transition-transform active:scale-95"
    >
      <Icon name="add" className="text-[18px]" />
      {children}
    </button>
  );
}

interface DraftComponent {
  key: string;
  ingredientId: string;
  quantity: string;
  weightBasis: WeightBasis;
  cookingMethod: string;
  isOptional: boolean;
  /** ADR 0004: el rol se declara, no se adivina desde los macros. */
  role: "MAIN" | "ADDED_FAT" | "SEASONING";
}

interface DraftAlternative {
  key: string;
  ingredientId: string;
  compatibility: "EXCELLENT" | "GOOD" | "ACCEPTABLE";
}

const ROLE_LABELS: Record<DraftComponent["role"], string> = {
  MAIN: "Comida",
  ADDED_FAT: "Grasa añadida",
  SEASONING: "Aliño",
};

const COMPATIBILITY_LABELS: Record<DraftAlternative["compatibility"], string> = {
  EXCELLENT: "Reemplazo directo",
  GOOD: "Buen reemplazo",
  ACCEPTABLE: "Aceptable",
};

interface DraftSlot {
  key: string;
  slotType: SlotType;
  isRequired: boolean;
  components: DraftComponent[];
  alternatives: DraftAlternative[];
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
            // Una grasa se marca sola por su slot; el resto es comida hasta que
            // alguien diga lo contrario.
            role: slotType === "FAT" ? "ADDED_FAT" : "MAIN",
          },
        ],
        alternatives: [],
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
              role: c.role,
            };
          }),
        alternatives: slot.alternatives
          .filter((a) => a.ingredientId)
          .map((a) => ({
            ingredientId: a.ingredientId,
            culinaryCompatibility: a.compatibility,
            quantityEquivalence: null,
            notes: null,
          })),
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

  return (
    <div className="pb-[9rem] md:pb-24">
      <Section title="Lo básico">
        <Card className="space-y-md p-md">
          <div>
            <label htmlFor="name" className={LABEL}>
              ¿Cómo se llama?
            </label>
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pollo con arroz y ensalada"
              className={FIELD}
            />
          </div>

          <div>
            <p className={LABEL}>¿Cuándo se come?</p>
            <div className="flex flex-wrap gap-sm">
              {MEAL_TYPES.filter((t) => t !== "OTHER").map((type) => {
                const on = mealTypes.includes(type);
                return (
                  <OpcionChip
                    key={type}
                    activa={on}
                    onClick={() =>
                      setMealTypes((current) =>
                        on ? current.filter((t) => t !== type) : [...current, type],
                      )
                    }
                  >
                    {MEAL_TYPE_LABELS[type]}
                  </OpcionChip>
                );
              })}
            </div>
          </div>

          <div className="flex gap-sm">
            <div className="min-w-0 flex-1">
              <label htmlFor="servings" className={LABEL}>
                ¿Para cuántas personas?
              </label>
              <input
                id="servings"
                type="number"
                min={1}
                max={50}
                value={baseServings}
                onChange={(e) => setBaseServings(e.target.value)}
                className={FIELD}
              />
              <p className="mt-xs font-body-sm text-body-sm text-on-surface-variant">
                Las cantidades que anotes son de la olla completa para esta cantidad de gente.
              </p>
            </div>
            <div className="w-24 shrink-0">
              <label htmlFor="time" className={LABEL}>
                Minutos
              </label>
              <input
                id="time"
                type="number"
                min={1}
                value={baseTime}
                onChange={(e) => setBaseTime(e.target.value)}
                className={FIELD}
              />
            </div>
          </div>

          <div>
            <p className={LABEL}>Tipo</p>
            <div className="flex flex-wrap gap-sm">
              {(["MEAL", "SALAD", "DESSERT"] as TemplateKind[]).map((k) => (
                <OpcionChip key={k} activa={kind === k} onClick={() => setKind(k)}>
                  {k === "MEAL" ? "Plato" : k === "SALAD" ? "Ensalada" : "Postre"}
                </OpcionChip>
              ))}
            </div>
          </div>
        </Card>
      </Section>

      {slots.map((slot) => (
        <Card key={slot.key} as="section" className="mb-md p-md">
          <div className="mb-sm flex items-center gap-sm">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-container text-primary">
              <Icon name="restaurant_menu" filled />
            </span>
            <h3 className="min-w-0 flex-1 truncate font-headline-sm text-headline-sm text-on-surface">
              {SLOT_LABELS[slot.slotType]}
            </h3>
            <BotonQuitar
              label={`Quitar ${SLOT_LABELS[slot.slotType].toLowerCase()}`}
              onClick={() => setSlots((c) => c.filter((s) => s.key !== slot.key))}
            />
          </div>

          <div className="space-y-sm">
            {slot.components.map((component) => (
              <div
                key={component.key}
                className="space-y-sm rounded-2xl bg-surface-container-low p-md"
              >
                <select
                  value={component.ingredientId}
                  onChange={(e) =>
                    updateComponent(slot.key, component.key, { ingredientId: e.target.value })
                  }
                  className={FIELD}
                  aria-label="Alimento"
                >
                  <option value="">Elegir alimento…</option>
                  {ingredients.map((ingredient) => (
                    <option key={ingredient.id} value={ingredient.id}>
                      {ingredient.name}
                    </option>
                  ))}
                </select>

                <div className="flex gap-sm">
                  <input
                    type="number"
                    min={0}
                    step="any"
                    placeholder="Gramos"
                    value={component.quantity}
                    onChange={(e) =>
                      updateComponent(slot.key, component.key, { quantity: e.target.value })
                    }
                    className={`${FIELD} flex-1`}
                    aria-label="Cantidad"
                  />
                  <select
                    value={component.weightBasis}
                    onChange={(e) =>
                      updateComponent(slot.key, component.key, {
                        weightBasis: e.target.value as WeightBasis,
                      })
                    }
                    className={`${FIELD} flex-1`}
                    aria-label="Estado del alimento"
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

                <div className="flex flex-wrap items-center gap-sm">
                  <select
                    value={component.cookingMethod}
                    onChange={(e) =>
                      updateComponent(slot.key, component.key, { cookingMethod: e.target.value })
                    }
                    className={`${FIELD} min-w-0 flex-1`}
                    aria-label="Método de cocción"
                  >
                    <option value="">Sin método</option>
                    {COOKING_METHODS.map((method) => (
                      <option key={method} value={method}>
                        {COOKING_METHOD_LABELS[method]}
                      </option>
                    ))}
                  </select>
                  <label className="flex min-h-[44px] shrink-0 items-center gap-sm font-body-sm text-body-sm text-on-surface-variant">
                    <input
                      type="checkbox"
                      checked={component.isOptional}
                      onChange={(e) =>
                        updateComponent(slot.key, component.key, { isOptional: e.target.checked })
                      }
                      className="h-5 w-5 accent-primary"
                    />
                    Opcional
                  </label>
                  {slot.components.length > 1 && (
                    <BotonQuitar
                      label="Quitar este alimento"
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
                    />
                  )}
                </div>

                <div>
                  <p className="mb-xs font-body-sm text-body-sm text-on-surface-variant">
                    ¿Qué es en el plato? Solo la <strong>grasa añadida</strong> se le puede quitar a
                    quien prefiere evitarla; la palta o el queso son comida aunque sean grasos.
                  </p>
                  <div className="flex flex-wrap gap-sm">
                    {(["MAIN", "ADDED_FAT", "SEASONING"] as DraftComponent["role"][]).map((r) => (
                      <OpcionChip
                        key={r}
                        activa={component.role === r}
                        onClick={() => updateComponent(slot.key, component.key, { role: r })}
                      >
                        {ROLE_LABELS[r]}
                      </OpcionChip>
                    ))}
                  </div>
                </div>

                {component.ingredientId &&
                  byId.get(component.ingredientId)?.facts.length === 0 && (
                    <Notice icon="warning">
                      Este alimento no tiene datos nutricionales: el plato quedará con cálculo
                      incompleto.
                    </Notice>
                  )}
              </div>
            ))}
          </div>

          <div className="mt-md border-t border-outline-variant/40 pt-md">
            <p className="font-label-md text-label-md text-on-surface-variant">
              En vez de esto también sirve
            </p>
            <p className="mt-xs mb-sm font-body-sm text-body-sm text-on-surface-variant">
              Reemplazos válidos en la cocina. No afirman equivalencia nutricional: la cantidad la
              recalcula el motor de porciones.
            </p>

            {slot.alternatives.map((alt) => (
              <div key={alt.key} className="mb-sm flex items-center gap-sm">
                <select
                  value={alt.ingredientId}
                  onChange={(e) =>
                    setSlots((current) =>
                      current.map((s) =>
                        s.key !== slot.key
                          ? s
                          : {
                              ...s,
                              alternatives: s.alternatives.map((a) =>
                                a.key === alt.key ? { ...a, ingredientId: e.target.value } : a,
                              ),
                            },
                      ),
                    )
                  }
                  className={`${FIELD} min-w-0 flex-1`}
                  aria-label="Alimento de reemplazo"
                >
                  <option value="">Elegir alimento…</option>
                  {ingredients.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
                <select
                  value={alt.compatibility}
                  onChange={(e) =>
                    setSlots((current) =>
                      current.map((s) =>
                        s.key !== slot.key
                          ? s
                          : {
                              ...s,
                              alternatives: s.alternatives.map((a) =>
                                a.key === alt.key
                                  ? { ...a, compatibility: e.target.value as DraftAlternative["compatibility"] }
                                  : a,
                              ),
                            },
                      ),
                    )
                  }
                  className={`${FIELD} min-w-0 flex-1`}
                  aria-label="Qué tan bien reemplaza"
                >
                  {(["EXCELLENT", "GOOD", "ACCEPTABLE"] as DraftAlternative["compatibility"][]).map(
                    (c) => (
                      <option key={c} value={c}>
                        {COMPATIBILITY_LABELS[c]}
                      </option>
                    ),
                  )}
                </select>
                <BotonQuitar
                  label="Quitar alternativa"
                  onClick={() =>
                    setSlots((current) =>
                      current.map((s) =>
                        s.key !== slot.key
                          ? s
                          : { ...s, alternatives: s.alternatives.filter((a) => a.key !== alt.key) },
                      ),
                    )
                  }
                />
              </div>
            ))}

            <BotonAgregar
              onClick={() =>
                setSlots((current) =>
                  current.map((s) =>
                    s.key !== slot.key
                      ? s
                      : {
                          ...s,
                          alternatives: [
                            ...s.alternatives,
                            { key: nextKey(), ingredientId: "", compatibility: "GOOD" as const },
                          ],
                        },
                  ),
                )
              }
            >
              Agregar alternativa
            </BotonAgregar>
          </div>

          <div className="mt-sm">
            <BotonAgregar
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
                              role: (slot.slotType === "FAT" ? "ADDED_FAT" : "MAIN") as
                                DraftComponent["role"],
                            },
                          ],
                        },
                  ),
                )
              }
            >
              Agregar otro alimento a {SLOT_LABELS[slot.slotType].toLowerCase()}
            </BotonAgregar>
          </div>
        </Card>
      ))}

      <Section title="¿Qué lleva el plato?">
        <div className="flex flex-wrap gap-sm">
          {OFFERED_SLOTS.map((slotType) => (
            <button
              key={slotType}
              type="button"
              onClick={() => addSlot(slotType)}
              className="inline-flex min-h-[44px] items-center gap-xs rounded-full border border-primary px-md py-sm font-body-sm text-body-sm font-semibold text-primary transition-transform active:scale-95"
            >
              <Icon name="add" className="text-[18px]" />
              {SLOT_ADD_LABELS[slotType]}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Preparación">
        <Card className="p-md">
          <div className="space-y-sm">
            {steps.map((step, index) => (
              <div key={step.key} className="flex gap-sm">
                <span className="mt-sm w-6 shrink-0 font-label-md text-label-md text-on-surface-variant">
                  {index + 1}.
                </span>
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
                  className={`${FIELD} min-w-0 flex-1`}
                  aria-label={`Paso ${index + 1}`}
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
                  className={`${FIELD} w-20 shrink-0`}
                  aria-label={`Minutos del paso ${index + 1}`}
                />
              </div>
            ))}
          </div>
          <div className="mt-sm">
            <BotonAgregar
              onClick={() =>
                setSteps((current) => [
                  ...current,
                  { key: nextKey(), instruction: "", durationMinutes: "" },
                ])
              }
            >
              Agregar paso
            </BotonAgregar>
          </div>
        </Card>
      </Section>

      {nutrition && (
        <div className="mb-lg space-y-sm">
          <NutritionPanel title="Así va el plato completo" nutrition={nutrition.total} />
          <NutritionPanel title="Por porción" nutrition={nutrition.perServing} compact />
        </div>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      {/* Barra fija: en móvil se apoya SOBRE la navegación inferior, no debajo. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-outline-variant/30 bg-surface-container-lowest/95 px-container-margin pt-sm pb-[88px] backdrop-blur-md md:pb-sm">
        <div className="mx-auto flex max-w-[48rem] gap-sm">
          <ButtonOutline className="flex-1" disabled={pending} onClick={() => submit(false)}>
            <Icon name="save" className="text-[18px]" />
            Guardar borrador
          </ButtonOutline>
          <Button className="flex-1" disabled={pending} onClick={() => submit(true)}>
            <Icon name="publish" className="text-[18px]" />
            Publicar
          </Button>
        </div>
      </div>
    </div>
  );
}
