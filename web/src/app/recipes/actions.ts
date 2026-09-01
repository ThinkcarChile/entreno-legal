"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import { NUTRIENT_KEYS } from "@/domain/catalog/types";
import { calculateMealNutrition } from "@/domain/recipes/nutrition";
import { recipeDraftSchema, type RecipeDraftInput } from "@/domain/recipes/schemas";
import { loadRecipeDetail } from "./queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { loadCurrentMembership } from "@/app/family/current-household";

export interface ActionResult {
  ok: boolean;
  error?: string;
  templateId?: string;
  versionId?: string;
}

async function currentMembership() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/recipes");

  // Mismo criterio que la portada (F-1): la receta se crea EN un hogar y ese
  // hogar no puede cambiar entre una carga y la siguiente.
  const membership = await loadCurrentMembership(supabase, user.id);

  return { supabase, membership };
}

/** Crea la receta y guarda su primer borrador en una sola pasada. */
export async function createRecipe(input: RecipeDraftInput): Promise<ActionResult> {
  const parsed = recipeDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }
  const draft = parsed.data;

  const { supabase, membership } = await currentMembership();
  if (!membership) {
    return { ok: false, error: "Primero crea o únete a un hogar (pestaña Familia)." };
  }

  const { data: versionId, error } = await supabase.rpc("create_meal_template", {
    p_household_id: membership.householdId,
    p_name: draft.name,
    p_kind: draft.kind,
    p_meal_types: draft.mealTypes,
    p_base_servings: draft.baseServings,
  });
  if (error || !versionId) {
    return { ok: false, error: "No se pudo crear la receta." };
  }

  const saved = await saveDraft(versionId as string, draft);
  if (!saved.ok) return saved;

  const { data: version, error: err1Version } = await supabase
    .from("meal_template_versions")
    .select("template_id")
    .eq("id", versionId)
    .maybeSingle();
  if (err1Version) throw new DataAccessError("version de la receta", err1Version);

  return { ok: true, versionId: versionId as string, templateId: version?.template_id };
}

/** Reemplaza el contenido del borrador de forma atómica. */
export async function saveDraft(
  versionId: string,
  input: RecipeDraftInput,
): Promise<ActionResult> {
  const parsed = recipeDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }
  const draft = parsed.data;
  const { supabase } = await currentMembership();

  const payload = {
    name: draft.name,
    description: draft.description ?? null,
    meal_types: draft.mealTypes,
    base_servings: draft.baseServings,
    base_time_minutes: draft.baseTimeMinutes ?? null,
    total_yield_factor: draft.totalYieldFactor ?? null,
    slots: draft.slots.map((slot, slotIndex) => ({
      slot_type: slot.slotType,
      label: slot.label ?? null,
      is_required: slot.isRequired,
      sort_order: slotIndex + 1,
      components: slot.components.map((component, index) => ({
        ingredient_id: component.ingredientId ?? null,
        product_id: component.productId ?? null,
        nested_version_id: component.nestedVersionId ?? null,
        quantity: component.quantity,
        unit: component.unit,
        weight_basis: component.weightBasis,
        nutrition_fact_id: component.nutritionFactId ?? null,
        cooking_method: component.cookingMethod ?? null,
        yield_factor: component.yieldFactor ?? null,
        is_optional: component.isOptional,
        role: component.role ?? "MAIN",
        sort_order: index + 1,
      })),
      alternatives: slot.alternatives.map((alternative) => ({
        ingredient_id: alternative.ingredientId ?? null,
        culinary_compatibility: alternative.culinaryCompatibility,
        quantity_equivalence: alternative.quantityEquivalence ?? null,
        notes: alternative.notes ?? null,
      })),
    })),
    steps: draft.steps.map((step, index) => ({
      step_number: index + 1,
      instruction: step.instruction,
      duration_minutes: step.durationMinutes ?? null,
      temperature_c: step.temperatureC ?? null,
      required_capability: step.requiredCapability ?? null,
      optional_capability: step.optionalCapability ?? null,
      manual_alternative: step.manualAlternative ?? null,
      parallel_group: step.parallelGroup ?? null,
    })),
  };

  const { error } = await supabase.rpc("replace_draft_content", {
    p_version_id: versionId,
    p_payload: payload,
  });
  if (error) {
    return { ok: false, error: "No se pudo guardar el borrador." };
  }

  revalidatePath("/recipes");
  return { ok: true, versionId };
}

/**
 * Publica la versión: la base congela la ficha nutricional de cada componente,
 * y aquí se recalcula el cache de nutrición desde esas fichas ya congeladas.
 */
export async function publishVersion(
  templateId: string,
  versionId: string,
): Promise<ActionResult> {
  const { supabase } = await currentMembership();

  const { error } = await supabase.rpc("publish_meal_template_version", {
    p_version_id: versionId,
  });
  if (error) {
    return { ok: false, error: error.message.includes("sin ingredientes")
      ? "Agrega al menos un ingrediente antes de publicar."
      : "No se pudo publicar la receta." };
  }

  const detail = await loadRecipeDetail(supabase, templateId, versionId);
  if (detail) {
    const { total } = calculateMealNutrition(detail.components, detail.baseServings);
    const row: Record<string, unknown> = {
      version_id: versionId,
      completeness: total.completeness,
      computed_at: new Date().toISOString(),
    };
    for (const key of NUTRIENT_KEYS) {
      const value = total.values[key];
      row[key] = value === null || value === undefined ? null : Math.round(value * 1000) / 1000;
    }
    // Gate final §5: si la ficha agregada de la receta no se pudo guardar, la
    // publicación NO puede reportar éxito con la nutrición vieja en caché.
    const { error: nutricionError } = await supabase
      .from("recipe_nutrition")
      .upsert(row, { onConflict: "version_id" });
    if (nutricionError) {
      throw new DataAccessError("nutrición agregada de la receta", nutricionError);
    }
  }

  revalidatePath("/recipes");
  revalidatePath(`/recipes/${templateId}`);
  return { ok: true, templateId, versionId };
}

/** Editar una versión publicada = crear la siguiente en borrador (K-21). */
export async function startNewVersion(
  templateId: string,
  versionId: string,
): Promise<ActionResult> {
  const { supabase } = await currentMembership();
  const { data, error } = await supabase.rpc("create_draft_from_version", {
    p_version_id: versionId,
  });
  if (error || !data) {
    return {
      ok: false,
      error: error?.message.includes("ya existe un borrador")
        ? "Ya hay un borrador abierto para esta receta."
        : "No se pudo crear la versión nueva.",
    };
  }
  revalidatePath(`/recipes/${templateId}`);
  return { ok: true, templateId, versionId: data as string };
}

/** Duplicar, y también "copiar a mis recetas" cuando la original es global. */
export async function duplicateRecipe(templateId: string): Promise<ActionResult> {
  const { supabase, membership } = await currentMembership();
  if (!membership) {
    return { ok: false, error: "Primero crea o únete a un hogar (pestaña Familia)." };
  }

  const { data, error } = await supabase.rpc("duplicate_meal_template", {
    p_template_id: templateId,
    p_household_id: membership.householdId,
    p_name: null,
  });
  if (error || !data) {
    return { ok: false, error: "No se pudo duplicar la receta." };
  }

  revalidatePath("/recipes");
  return { ok: true, templateId: data as string };
}
