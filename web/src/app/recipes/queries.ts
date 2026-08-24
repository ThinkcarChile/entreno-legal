import type { SupabaseClient } from "@supabase/supabase-js";
import type { NutritionFact, NutritionValues, SourceType } from "@/domain/catalog/types";
import { NUTRIENT_KEYS } from "@/domain/catalog/types";
import {
  calculateMealNutrition,
  resolveComponentNutrition,
  type MealNutrition,
} from "@/domain/recipes/nutrition";
import { DataAccessError } from "@/lib/supabase/unwrap";
import type {
  CookingMethod,
  MealType,
  RecipeComponent,
  RecipeSlot,
  RecipeStep,
  SlotAlternative,
  SlotType,
  TemplateKind,
  TemplateStatus,
} from "@/domain/recipes/types";

/**
 * Traducción de filas a tipos de dominio. Regla clave: si la versión publicada
 * congeló su ficha (`frozen_nutrition`), esa es la que manda — una corrección
 * posterior del catálogo no reescribe la historia (ADR 0002 §3). Solo los
 * borradores leen la ficha viva.
 */

type Db = SupabaseClient;

export interface RecipeListItem {
  templateId: string;
  name: string;
  kind: TemplateKind;
  mealTypes: MealType[];
  isGlobal: boolean;
  status: TemplateStatus;
  versionNumber: number;
  versionId: string;
}

export interface RecipeSource {
  label: string;
  sourceType: SourceType | null;
  sourceName: string | null;
  verified: boolean;
  frozen: boolean;
}

export interface RecipeDetail {
  templateId: string;
  name: string;
  description: string | null;
  kind: TemplateKind;
  isGlobal: boolean;
  isOwn: boolean;
  versionId: string;
  versionNumber: number;
  status: TemplateStatus;
  mealTypes: MealType[];
  baseServings: number;
  baseTimeMinutes: number | null;
  totalYieldFactor: number | null;
  slots: RecipeSlot[];
  components: RecipeComponent[];
  alternatives: SlotAlternative[];
  steps: RecipeStep[];
  nutrition: MealNutrition;
  /** Componentes que no se pudieron calcular. Se muestran; jamás se ocultan. */
  issues: string[];
  sources: RecipeSource[];
  versions: { id: string; versionNumber: number; status: TemplateStatus }[];
}

interface FactRow {
  id: string;
  weight_basis: string;
  basis_unit: string;
  source_type: string;
  source_name: string;
  verified: boolean;
  [key: string]: unknown;
}

function factFromRow(row: FactRow | null): NutritionFact | null {
  if (!row) return null;
  const values: NutritionValues = {};
  for (const key of NUTRIENT_KEYS) {
    const raw = row[key];
    values[key] = raw === null || raw === undefined ? null : Number(raw);
  }
  return {
    values,
    weightBasis: row.weight_basis as NutritionFact["weightBasis"],
    basisUnit: row.basis_unit as NutritionFact["basisUnit"],
  };
}

function factFromFrozen(frozen: unknown): NutritionFact | null {
  if (!frozen || typeof frozen !== "object") return null;
  const snapshot = frozen as {
    weight_basis?: string;
    basis_unit?: string;
    values?: Record<string, number | null>;
  };
  if (!snapshot.weight_basis || !snapshot.basis_unit) return null;
  const values: NutritionValues = {};
  for (const key of NUTRIENT_KEYS) {
    const raw = snapshot.values?.[key];
    values[key] = raw === null || raw === undefined ? null : Number(raw);
  }
  return {
    values,
    weightBasis: snapshot.weight_basis as NutritionFact["weightBasis"],
    basisUnit: snapshot.basis_unit as NutritionFact["basisUnit"],
  };
}

const COMPONENT_SELECT = `
  id, slot_id, ingredient_id, product_id, nested_version_id,
  quantity, unit, weight_basis, cooking_method, yield_factor, is_optional, sort_order,
  adjustability, min_quantity, max_quantity, role,
  frozen_nutrition, frozen_source,
  ingredients ( display_name, category_id ),
  commercial_products ( name, brand ),
  nutrition_facts (
    id, weight_basis, basis_unit, source_type, source_name, verified,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugars_g,
    saturated_fat_g, sodium_mg, potassium_mg, phosphorus_mg
  )
`;

interface ComponentRow {
  id: string;
  slot_id: string;
  ingredient_id: string | null;
  product_id: string | null;
  nested_version_id: string | null;
  quantity: number;
  unit: string;
  weight_basis: string;
  cooking_method: string | null;
  yield_factor: number | null;
  is_optional: boolean;
  sort_order: number;
  adjustability: "FIXED" | "ADJUSTABLE" | "OPTIONAL";
  role: "MAIN" | "ADDED_FAT" | "SEASONING" | null;
  min_quantity: number | null;
  max_quantity: number | null;
  frozen_nutrition: unknown;
  frozen_source: { source_type?: string; source_name?: string; verified?: boolean } | null;
  ingredients: { display_name: string; category_id: string | null } | null;
  commercial_products: { name: string; brand: string | null } | null;
  nutrition_facts: FactRow | null;
}

function componentLabel(row: ComponentRow): string {
  if (row.ingredients) return row.ingredients.display_name;
  if (row.commercial_products) {
    const { brand, name } = row.commercial_products;
    return brand ? `${brand} ${name}` : name;
  }
  return "Componente";
}

/** Componente + de dónde salió su nutrición, para no perder la procedencia. */
type LoadedComponent = RecipeComponent & { source: RecipeSource | null };

function toComponent(row: ComponentRow, slotType: SlotType): LoadedComponent {
  const frozen = factFromFrozen(row.frozen_nutrition);
  const frozenSource = row.frozen_source;
  const liveSource = row.nutrition_facts;
  const label = componentLabel(row);
  const source: RecipeSource | null =
    frozenSource || liveSource
      ? {
          label,
          sourceType: ((frozenSource?.source_type ?? liveSource?.source_type) as SourceType) ?? null,
          sourceName: frozenSource?.source_name ?? liveSource?.source_name ?? null,
          verified: Boolean(frozenSource?.verified ?? liveSource?.verified),
          frozen: Boolean(frozenSource),
        }
      : null;
  return {
    source,
    id: row.id,
    slotId: row.slot_id,
    slotType,
    label,
    target: row.ingredient_id
      ? { kind: "INGREDIENT", ingredientId: row.ingredient_id }
      : row.product_id
        ? { kind: "PRODUCT", productId: row.product_id }
        : { kind: "SALAD", saladVersionId: row.nested_version_id! },
    quantity: Number(row.quantity),
    unit: row.unit as RecipeComponent["unit"],
    weightBasis: row.weight_basis as RecipeComponent["weightBasis"],
    // Congelada si existe; si no, la ficha viva (solo pasa en borradores).
    nutrition: frozen ?? factFromRow(row.nutrition_facts),
    cookingMethod: (row.cooking_method as CookingMethod | null) ?? null,
    yieldFactor: row.yield_factor === null ? null : Number(row.yield_factor),
    isOptional: row.is_optional,
    sortOrder: row.sort_order,
    adjustability: row.adjustability ?? "ADJUSTABLE",
    role: row.role ?? "MAIN",
    minQuantity: row.min_quantity === null ? null : Number(row.min_quantity),
    maxQuantity: row.max_quantity === null ? null : Number(row.max_quantity),
    categoryId: row.ingredients?.category_id ?? null,
  };
}

/**
 * Expande un componente que referencia otra receta (ensalada/postre reutilizable)
 * a los componentes reales de ESA versión, escalados a la cantidad usada.
 * Una sola vuelta de anidamiento: una ensalada dentro de una ensalada dentro de
 * un plato no aporta nada y sí abre la puerta a ciclos.
 */
async function expandNested(
  db: Db,
  component: LoadedComponent,
  versionId: string,
): Promise<LoadedComponent[]> {
  const { data: slots, error: err1Slots } = await db
    .from("meal_slots")
    .select(`id, slot_type, version_id`)
    .eq("version_id", versionId);
  if (err1Slots) throw new DataAccessError("slots de la receta anidada", err1Slots);
  if (!slots?.length) return [];

  const { data: rows, error: err1Rows } = await db
    .from("meal_slot_components")
    .select(COMPONENT_SELECT)
    .in("slot_id", slots.map((s) => s.id));
  if (err1Rows) throw new DataAccessError("componentes de la receta anidada", err1Rows);
  if (!rows?.length) return [];

  const slotTypeById = new Map(slots.map((s) => [s.id, s.slot_type as SlotType]));
  const inner = (rows as unknown as ComponentRow[]).map((row) =>
    toComponent(row, slotTypeById.get(row.slot_id) ?? "OTHER"),
  );

  // La cantidad del componente anidado es el peso total que entra al plato:
  // se reparte proporcionalmente entre los componentes de la ensalada.
  const innerTotal = inner.reduce((sum, c) => sum + c.quantity, 0);
  const factor = innerTotal > 0 ? component.quantity / innerTotal : 1;

  return inner.map((c) => ({
    ...c,
    id: `${component.id}:${c.id}`,
    // El slot del plato manda para AGRUPAR en pantalla, pero cada componente
    // conserva SU tipo: el aceite de la ensalada sigue siendo una grasa añadida
    // y quien la evita tiene que poder sacarla.
    slotId: component.slotId,
    quantity: c.quantity * factor,
    isOptional: component.isOptional || c.isOptional,
  }));
}

/** Listado: recetas globales + del hogar. */
export async function loadRecipes(
  db: Db,
  filters: { mealType?: MealType; kind?: TemplateKind; search?: string } = {},
): Promise<RecipeListItem[]> {
  let query = db
    .from("meal_templates")
    .select(
      // Hay DOS claves foráneas entre estas tablas (versión->receta y
      // receta.current_version_id): PostgREST exige decir cuál se usa.
      `id, name, kind, household_id, current_version_id,
       meal_template_versions!meal_template_versions_template_id_fkey (
         id, version_number, status, meal_types
       )`,
    )
    .eq("is_active", true)
    .order("name");

  if (filters.kind) query = query.eq("kind", filters.kind);
  if (filters.search) query = query.ilike("name", `%${filters.search}%`);

  const { data, error } = await query;
  // Un fallo de consulta no puede disfrazarse de "no hay recetas": esa mentira
  // fue justo lo que escondió el error de relaciones ambiguas de PostgREST.
  if (error) {
    throw new Error(`No se pudo leer el recetario (${error.code}): ${error.message}`);
  }
  if (!data) return [];

  const items: RecipeListItem[] = [];
  for (const template of data) {
    const versions = (template.meal_template_versions ?? []) as {
      id: string;
      version_number: number;
      status: TemplateStatus;
      meal_types: MealType[];
    }[];
    if (!versions.length) continue;

    // La que se muestra: la publicada vigente, o el borrador más nuevo.
    const published = versions.find((v) => v.id === template.current_version_id);
    const shown =
      published ?? [...versions].sort((a, b) => b.version_number - a.version_number)[0]!;

    if (filters.mealType && !(shown.meal_types ?? []).includes(filters.mealType)) continue;

    items.push({
      templateId: template.id,
      name: template.name,
      kind: template.kind as TemplateKind,
      mealTypes: shown.meal_types ?? [],
      isGlobal: template.household_id === null,
      status: shown.status,
      versionNumber: shown.version_number,
      versionId: shown.id,
    });
  }
  return items;
}

/** Detalle de una versión concreta (por defecto, la vigente). */
export async function loadRecipeDetail(
  db: Db,
  templateId: string,
  versionId?: string,
): Promise<RecipeDetail | null> {
  const { data: template, error: err1Template } = await db
    .from("meal_templates")
    .select(`id, name, kind, household_id, current_version_id`)
    .eq("id", templateId)
    .maybeSingle();
  if (err1Template) throw new DataAccessError("plantilla de receta", err1Template);
  if (!template) return null;

  const { data: versionRows, error: err1VersionRows } = await db
    .from("meal_template_versions")
    .select(
      `id, version_number, status, name, description, meal_types,
       base_servings, base_time_minutes, total_yield_factor`,
    )
    .eq("template_id", templateId)
    .order("version_number", { ascending: false });
  if (err1VersionRows) throw new DataAccessError("versiones de la receta", err1VersionRows);
  if (!versionRows?.length) return null;

  const target =
    versionRows.find((v) => v.id === versionId) ??
    versionRows.find((v) => v.id === template.current_version_id) ??
    versionRows[0]!;

  const { data: slotRows, error: err1SlotRows } = await db
    .from("meal_slots")
    .select(`id, slot_type, label, is_required, sort_order`)
    .eq("version_id", target.id)
    .order("sort_order");
  if (err1SlotRows) throw new DataAccessError("slots de la receta", err1SlotRows);
  const slots: RecipeSlot[] = (slotRows ?? []).map((s) => ({
    id: s.id,
    slotType: s.slot_type as SlotType,
    label: s.label,
    isRequired: s.is_required,
    sortOrder: s.sort_order,
  }));

  const components: LoadedComponent[] = [];
  let alternatives: SlotAlternative[] = [];

  if (slots.length) {
    const slotIds = slots.map((s) => s.id);
    const slotTypeById = new Map(slots.map((s) => [s.id, s.slotType]));

    const { data: componentRows, error: err1ComponentRows } = await db
      .from("meal_slot_components")
      .select(COMPONENT_SELECT)
      .in("slot_id", slotIds)
      .order("sort_order");
    if (err1ComponentRows) throw new DataAccessError("componentes de la receta", err1ComponentRows);

    for (const row of (componentRows ?? []) as unknown as ComponentRow[]) {
      const component = toComponent(row, slotTypeById.get(row.slot_id) ?? "OTHER");
      if (row.nested_version_id) {
        components.push(...(await expandNested(db, component, row.nested_version_id)));
      } else {
        components.push(component);
      }
    }

    const { data: altRows, error: err1AltRows } = await db
      .from("meal_slot_alternatives")
      .select(
        `id, slot_id, ingredient_id, product_id, nested_version_id,
         culinary_compatibility, quantity_equivalence, notes,
         ingredients ( display_name ), commercial_products ( name, brand )`,
      )
      .in("slot_id", slotIds);
    if (err1AltRows) throw new DataAccessError("alternativas de la receta", err1AltRows);

    alternatives = (altRows ?? []).map((row) => {
      const ingredient = row.ingredients as unknown as { display_name: string } | null;
      const product = row.commercial_products as unknown as {
        name: string;
        brand: string | null;
      } | null;
      return {
        id: row.id,
        slotId: row.slot_id,
        label: ingredient?.display_name ?? product?.name ?? "Alternativa",
        target: row.ingredient_id
          ? { kind: "INGREDIENT" as const, ingredientId: row.ingredient_id }
          : row.product_id
            ? { kind: "PRODUCT" as const, productId: row.product_id }
            : { kind: "SALAD" as const, saladVersionId: row.nested_version_id! },
        culinaryCompatibility: row.culinary_compatibility as SlotAlternative["culinaryCompatibility"],
        quantityEquivalence:
          row.quantity_equivalence === null ? null : Number(row.quantity_equivalence),
        notes: row.notes,
      };
    });
  }

  const { data: stepRows, error: err1StepRows } = await db
    .from("recipe_steps")
    .select(
      `id, step_number, instruction, duration_minutes, temperature_c,
       required_capability, optional_capability, manual_alternative, parallel_group, notes`,
    )
    .eq("version_id", target.id)
    .order("step_number");
  if (err1StepRows) throw new DataAccessError("pasos de la receta", err1StepRows);

  const steps: RecipeStep[] = (stepRows ?? []).map((s) => ({
    id: s.id,
    stepNumber: s.step_number,
    instruction: s.instruction,
    durationMinutes: s.duration_minutes,
    temperatureC: s.temperature_c,
    requiredCapability: s.required_capability,
    optionalCapability: s.optional_capability,
    manualAlternative: s.manual_alternative,
    parallelGroup: s.parallel_group,
    notes: s.notes,
  }));

  // La procedencia sale de los componentes YA expandidos: así la ensalada
  // anidada también declara de dónde vienen sus números.
  const seen = new Set<string>();
  const sources: RecipeSource[] = [];
  for (const component of components) {
    if (!component.source || seen.has(component.label)) continue;
    seen.add(component.label);
    sources.push(component.source);
  }

  // Un componente con datos inconsistentes (p. ej. cantidad en g con ficha por
  // 100 ml) no puede tumbar la receta entera, pero tampoco puede pasar callado:
  // aporta DESCONOCIDO y el problema se muestra en pantalla.
  const issues: string[] = [];
  const usable = components.map((component) => {
    try {
      resolveComponentNutrition(component);
      return component;
    } catch (error) {
      issues.push(`${component.label}: ${(error as Error).message}`);
      return { ...component, nutrition: null };
    }
  });

  return {
    templateId: template.id,
    name: template.name,
    description: target.description,
    kind: template.kind as TemplateKind,
    isGlobal: template.household_id === null,
    isOwn: template.household_id !== null,
    versionId: target.id,
    versionNumber: target.version_number,
    status: target.status as TemplateStatus,
    mealTypes: (target.meal_types ?? []) as MealType[],
    baseServings: target.base_servings,
    baseTimeMinutes: target.base_time_minutes,
    totalYieldFactor:
      target.total_yield_factor === null ? null : Number(target.total_yield_factor),
    slots,
    components: usable,
    alternatives,
    steps,
    nutrition: calculateMealNutrition(usable, target.base_servings),
    issues,
    sources,
    versions: versionRows.map((v) => ({
      id: v.id,
      versionNumber: v.version_number,
      status: v.status as TemplateStatus,
    })),
  };
}

export interface IngredientOption {
  id: string;
  name: string;
  facts: {
    id: string;
    weightBasis: NutritionFact["weightBasis"];
    basisUnit: NutritionFact["basisUnit"];
    values: NutritionValues;
  }[];
}

/**
 * Alimentos disponibles para armar una receta, con TODAS sus fichas (una por
 * estado). El formulario necesita las fichas en el cliente para mostrar la
 * nutrición actualizándose mientras se escribe, sin ir al servidor por cada tecla.
 */
export async function loadIngredientOptions(db: Db): Promise<IngredientOption[]> {
  const { data, error: err1Data } = await db
    .from("ingredients")
    .select(
      `id, display_name,
       nutrition_facts (
         id, weight_basis, basis_unit,
         energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugars_g,
         saturated_fat_g, sodium_mg, potassium_mg, phosphorus_mg
       )`,
    )
    .eq("is_active", true)
    .order("display_name");
  if (err1Data) throw new DataAccessError("alimentos del catalogo", err1Data);

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.display_name,
    facts: ((row.nutrition_facts ?? []) as unknown as FactRow[]).map((fact) => {
      const parsed = factFromRow(fact)!;
      return {
        id: fact.id,
        weightBasis: parsed.weightBasis,
        basisUnit: parsed.basisUnit,
        values: parsed.values,
      };
    }),
  }));
}

/** Carga un borrador en la forma que usa el formulario de edición. */
export async function loadDraftForEdit(
  db: Db,
  templateId: string,
  versionId: string,
): Promise<RecipeDetail | null> {
  const detail = await loadRecipeDetail(db, templateId, versionId);
  if (!detail || detail.status !== "DRAFT") return null;
  return detail;
}
