"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { effectiveDate } from "@/domain/nutrition/calendar";
import type { TargetSet } from "@/domain/nutrition/types";
import { projectFamilyServings } from "@/domain/portions/family";
import type {
  AcceptedSubstitution,
  AvailableAlternative,
  PortionComponent,
} from "@/domain/portions/optimizer";
import type { MealType } from "@/domain/recipes/types";
import { loadDailyOverride, loadHouseholdProfiles } from "@/app/family/nutrition-queries";
import { loadRecipeDetail } from "@/app/recipes/queries";
import { NUTRIENT_KEYS } from "@/domain/catalog/types";
import { DataAccessError } from "@/lib/supabase/unwrap";

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

async function client() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/plan");
  return supabase;
}

/** Asigna una receta (o un tipo de comida sin receta) a un día. */
export async function assignMeal(input: {
  dayId: string;
  mealType: MealType;
  kind: "RECIPE" | "EAT_OUT" | "LEFTOVER" | "EVENT" | "FREE";
  templateId?: string | null;
  versionId?: string | null;
  notes?: string | null;
}): Promise<ActionResult> {
  const supabase = await client();

  if (input.kind === "RECIPE" && !input.versionId) {
    return { ok: false, error: "Elige una receta." };
  }

  const { error } = await supabase.from("meal_assignments").upsert(
    {
      day_id: input.dayId,
      meal_type: input.mealType,
      kind: input.kind,
      template_id: input.kind === "RECIPE" ? (input.templateId ?? null) : null,
      version_id: input.kind === "RECIPE" ? input.versionId : null,
      notes: input.notes ?? null,
      status: "PLANNED",
      confirmed_at: null,
      confirmed_by: null,
    },
    { onConflict: "day_id,meal_type" },
  );
  if (error) return { ok: false, error: "No se pudo planificar esa comida." };

  revalidatePath("/plan");
  return { ok: true, message: "Comida planificada." };
}

export async function clearAssignment(assignmentId: string): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.from("meal_assignments").delete().eq("id", assignmentId);
  if (error) return { ok: false, error: "No se pudo quitar esa comida." };
  revalidatePath("/plan");
  return { ok: true, message: "Comida quitada." };
}

/**
 * Confirmar una comida (§4 y §5 del preflight).
 *
 * Acá deja de ser una proyección efímera: se recalcula con el motor, con los
 * perfiles vigentes y la excepción del día, y se PERSISTE todo — cantidades,
 * nutrición, razones, reemplazos aceptados y las versiones de receta, perfil y
 * optimizador con las que se calculó. Meses después se puede responder "por qué
 * se sirvió esto".
 */
export async function confirmMeal(
  assignmentId: string,
  substitutionsByMember: Record<string, { componentId: string; ingredientId: string }[]> = {},
): Promise<ActionResult> {
  const supabase = await client();

  const { data: asignacion, error: asigError } = await supabase
    .from("meal_assignments")
    .select("id, meal_type, version_id, template_id, weekly_plan_days ( plan_date )")
    .eq("id", assignmentId)
    .maybeSingle();
  if (asigError) throw new DataAccessError("comida a confirmar", asigError);
  if (!asignacion?.version_id || !asignacion.template_id) {
    return { ok: false, error: "Esa comida no tiene una receta para calcular porciones." };
  }

  const dias = asignacion.weekly_plan_days as unknown;
  const fecha =
    (Array.isArray(dias) ? dias[0]?.plan_date : (dias as { plan_date?: string } | null)?.plan_date) ??
    null;

  const recipe = await loadRecipeDetail(supabase, asignacion.template_id, asignacion.version_id);
  if (!recipe) return { ok: false, error: "No se encontró la receta de esa comida." };

  const profiles = await loadHouseholdProfiles(supabase);
  if (profiles.length === 0) return { ok: false, error: "El hogar no tiene integrantes." };

  const mealType = asignacion.meal_type as MealType;

  const components: PortionComponent[] = recipe.components.map((c) => ({
    id: c.id,
    slotId: c.slotId,
    label: c.label,
    slotType: c.slotType,
    quantity: c.quantity,
    unit: c.unit,
    weightBasis: c.weightBasis,
    nutrition: c.nutrition,
    cookingMethod: c.cookingMethod,
    adjustability: c.adjustability,
    role: c.role,
    minQuantity: c.minQuantity,
    maxQuantity: c.maxQuantity,
    ingredientId: c.target.kind === "INGREDIENT" ? c.target.ingredientId : null,
    categoryId: c.categoryId,
    isOptional: c.isOptional,
  }));

  // Alternativas con su ficha, para poder aplicar un reemplazo aceptado.
  const alternativeIds = [
    ...new Set(
      recipe.alternatives
        .map((a) => (a.target.kind === "INGREDIENT" ? a.target.ingredientId : null))
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  let alternatives: AvailableAlternative[] = [];
  if (alternativeIds.length > 0) {
    const { data: fichas, error: fichasError } = await supabase
      .from("nutrition_facts")
      .select(
        `ingredient_id, weight_basis, basis_unit, energy_kcal, protein_g, carbohydrates_g,
         fat_g, fiber_g, sugars_g, saturated_fat_g, sodium_mg, potassium_mg, phosphorus_mg`,
      )
      .in("ingredient_id", alternativeIds);
    if (fichasError) throw new DataAccessError("fichas de las alternativas", fichasError);

    const porIngrediente = new Map<string, Record<string, unknown>>();
    for (const fila of fichas ?? []) {
      if (!porIngrediente.has(fila.ingredient_id) || fila.weight_basis === "RAW") {
        porIngrediente.set(fila.ingredient_id, fila);
      }
    }

    alternatives = recipe.alternatives
      .filter((a) => a.target.kind === "INGREDIENT")
      .map((a) => {
        const ingredientId = a.target.kind === "INGREDIENT" ? a.target.ingredientId : "";
        const fila = porIngrediente.get(ingredientId);
        const values: Record<string, number | null> = {};
        for (const key of NUTRIENT_KEYS) {
          const raw = fila?.[key];
          values[key] = raw === null || raw === undefined ? null : Number(raw);
        }
        return {
          slotId: a.slotId,
          ingredientId,
          label: a.label,
          nutrition: fila
            ? {
                values,
                weightBasis: fila.weight_basis as never,
                basisUnit: fila.basis_unit as never,
              }
            : null,
        };
      });
  }

  // Excepción del día de cada persona, en la zona horaria del hogar.
  const { data: hogar, error: hogarError } = await supabase
    .from("households")
    .select("timezone")
    .limit(1)
    .maybeSingle();
  if (hogarError) throw new DataAccessError("zona horaria del hogar", hogarError);
  const fechaEfectiva = fecha ?? effectiveDate(new Date(), hogar?.timezone ?? "America/Santiago");

  const overrides = new Map<string, { planId: string; targets: TargetSet } | null>();
  for (const profile of profiles) {
    const plan = await loadDailyOverride(supabase, profile.memberId, fechaEfectiva, mealType);
    overrides.set(
      profile.memberId,
      plan ? { planId: plan.planId, targets: plan.targets as TargetSet } : null,
    );
  }

  const proyeccion = projectFamilyServings({
    versionId: asignacion.version_id,
    components,
    alternatives,
    baseServings: recipe.baseServings,
    mealType,
    members: profiles.map((profile) => {
      const aceptados = substitutionsByMember[profile.memberId] ?? [];
      const substitutions: AcceptedSubstitution[] = aceptados
        .map((s) => {
          const alternativa = alternatives.find((a) => a.ingredientId === s.ingredientId);
          if (!alternativa) return null;
          return {
            componentId: s.componentId,
            ingredientId: s.ingredientId,
            label: alternativa.label,
            nutrition: alternativa.nutrition,
          };
        })
        .filter((x): x is AcceptedSubstitution => x !== null);

      return {
        profile,
        override: overrides.get(profile.memberId)?.targets ?? null,
        substitutions,
      };
    }),
  });

  // Se guarda todo, con las versiones que produjeron cada número.
  const payload = proyeccion.servings.map((serving) => {
    const profile = profiles.find((p) => p.memberId === serving.memberId)!;
    const aceptados = substitutionsByMember[serving.memberId] ?? [];
    return {
      member_id: serving.memberId,
      version_id: serving.versionId,
      profile_id: profile.profileId,
      daily_plan_id: overrides.get(serving.memberId)?.planId ?? null,
      optimizer_version: serving.optimizerVersion,
      meal_type: serving.mealType,
      serving_date: fechaEfectiva,
      fit: serving.fit,
      adaptation_level: serving.adaptationLevel,
      score: serving.score,
      nutrition: serving.nutrition.values,
      completeness: serving.nutrition.completeness,
      reasons: serving.reasons,
      unmet_constraints: serving.unmetConstraints,
      components: serving.components.map((c, i) => ({
        component_id: c.id.includes(":") ? null : c.id,
        label: c.label,
        base_quantity: c.baseQuantity,
        proposed_quantity: c.proposedQuantity,
        unit: c.unit,
        weight_basis: c.weightBasis,
        cooking_method: c.cookingMethod,
        added_fat_g: c.addedFatG,
        sort_order: i + 1,
      })),
      substitutions: aceptados.map((s) => ({
        component_id: s.componentId.includes(":") ? null : s.componentId,
        from_ingredient_id:
          components.find((c) => c.id === s.componentId)?.ingredientId ?? null,
        to_ingredient_id: s.ingredientId,
        reason_code: "SOFT_PREFERENCE",
      })),
    };
  });

  const missingProfile = payload.some((p) => !p.profile_id);
  if (missingProfile) {
    return {
      ok: false,
      error:
        "Falta publicar el perfil nutricional de algún integrante. Entra a su ficha y guarda una vez.",
    };
  }

  const { data: guardadas, error } = await supabase.rpc("confirm_meal_assignment", {
    p_assignment_id: assignmentId,
    p_servings: payload,
  });
  if (error) return { ok: false, error: `No se pudo confirmar: ${error.message}` };

  revalidatePath("/plan");
  return { ok: true, message: `Comida confirmada con ${guardadas} porciones guardadas.` };
}

export async function unconfirmMeal(assignmentId: string): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("unconfirm_meal_assignment", {
    p_assignment_id: assignmentId,
  });
  if (error) return { ok: false, error: "No se pudo deshacer la confirmación." };
  revalidatePath("/plan");
  return { ok: true, message: "La comida volvió a estar planificada." };
}

/** Un evento de la semana: cumpleaños, asado, viaje, comida libre. */
export async function saveEvent(input: {
  householdId: string;
  date: string;
  eventType: string;
  mealType: MealType | null;
  strategy: string;
  title: string;
}): Promise<ActionResult> {
  const supabase = await client();
  if (!input.title.trim()) return { ok: false, error: "El evento necesita un nombre." };

  const { error } = await supabase.from("nutrition_events").insert({
    household_id: input.householdId,
    event_date: input.date,
    event_type: input.eventType,
    meal_type: input.mealType,
    strategy: input.strategy,
    title: input.title.trim(),
  });
  if (error) return { ok: false, error: "No se pudo guardar el evento." };

  revalidatePath("/plan");
  return { ok: true, message: "Evento agregado." };
}

export async function deleteEvent(eventId: string): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.from("nutrition_events").delete().eq("id", eventId);
  if (error) return { ok: false, error: "No se pudo borrar el evento." };
  revalidatePath("/plan");
  return { ok: true, message: "Evento borrado." };
}
