"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import type { GoalType, TrackingMode } from "@/domain/nutrition/types";
import type { MealType } from "@/domain/recipes/types";
import { loadMemberProfile } from "./nutrition-queries";

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
  if (!user) redirect("/login?next=/family");
  return supabase;
}

/**
 * Republica el snapshot del integrante. Es lo único que dispara el recálculo, y
 * solo para ESA persona: los perfiles del resto de la familia no se tocan (§17).
 */
async function republishProfile(
  supabase: Awaited<ReturnType<typeof client>>,
  memberId: string,
  memberName: string,
  reason: string,
): Promise<void> {
  const profile = await loadMemberProfile(supabase, memberId, memberName);
  await supabase.rpc("publish_nutrition_profile", {
    p_member_id: memberId,
    p_tracking_mode: profile.trackingMode,
    p_input_signature: profile.inputSignature,
    p_computed_inputs: {
      goals: Object.keys(profile.dailyTargets).length,
      meals: Object.keys(profile.mealTargets).length,
      preferences: profile.preferences.length,
      cooking: profile.cookingPreferences.length,
    },
    p_daily_targets: profile.dailyTargets,
    p_meal_targets: profile.mealTargets,
    p_preferences: {
      addedFatStance: profile.addedFatStance,
      items: profile.preferences,
      cooking: profile.cookingPreferences,
    },
    p_reason: reason,
  });
}

export async function setTrackingMode(
  memberId: string,
  memberName: string,
  mode: TrackingMode,
): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase
    .from("member_tracking_settings")
    .upsert({ member_id: memberId, mode, updated_at: new Date().toISOString() }, { onConflict: "member_id" });
  if (error) return { ok: false, error: "No se pudo cambiar el seguimiento." };

  await republishProfile(supabase, memberId, memberName, `Seguimiento cambiado a ${mode}`);
  revalidatePath(`/family/${memberId}`);
  return { ok: true, message: "Tu perfil nutricional fue actualizado." };
}

export interface MealGoalInput {
  mealType: MealType;
  proteinMin: number | null;
  proteinPreferred: number | null;
  proteinMax: number | null;
  energyMax: number | null;
  saladPreference: "PREFERRED" | "NEUTRAL" | "AVOID";
  enabled: boolean;
  isFirstMeal: boolean;
}

/** Objetivo de una comida (§41). Los objetivos viejos se marcan SUPERSEDED: son historial. */
export async function saveMealGoals(
  memberId: string,
  memberName: string,
  input: MealGoalInput,
): Promise<ActionResult> {
  const supabase = await client();

  if (
    input.proteinMin !== null &&
    input.proteinMax !== null &&
    input.proteinMin > input.proteinMax
  ) {
    return { ok: false, error: "El mínimo de proteína no puede ser mayor que el máximo." };
  }

  const supersede = async (goalType: GoalType) => {
    await supabase
      .from("nutrition_goals")
      .update({ status: "SUPERSEDED", end_date: new Date().toISOString().slice(0, 10) })
      .eq("member_id", memberId)
      .eq("goal_type", goalType)
      .eq("scope", "PER_MEAL")
      .eq("meal_type", input.mealType)
      .eq("status", "ACTIVE");
  };

  await supersede("PROTEIN_G");
  await supersede("ENERGY_KCAL");

  const rows: Record<string, unknown>[] = [];
  if (input.proteinMin !== null || input.proteinPreferred !== null || input.proteinMax !== null) {
    rows.push({
      member_id: memberId,
      goal_type: "PROTEIN_G",
      scope: "PER_MEAL",
      meal_type: input.mealType,
      minimum: input.proteinMin,
      preferred: input.proteinPreferred,
      maximum: input.proteinMax,
      unit: "g",
      priority: 10,
    });
  }
  if (input.energyMax !== null) {
    rows.push({
      member_id: memberId,
      goal_type: "ENERGY_KCAL",
      scope: "PER_MEAL",
      meal_type: input.mealType,
      minimum: null,
      preferred: null,
      maximum: input.energyMax,
      unit: "kcal",
      priority: 20,
    });
  }
  if (rows.length > 0) {
    const { error } = await supabase.from("nutrition_goals").insert(rows);
    if (error) return { ok: false, error: "No se pudieron guardar los objetivos." };
  }

  // Patrón de la comida (habilitada, primera del día, ensalada).
  const { data: pattern } = await supabase
    .from("meal_patterns")
    .select("id")
    .eq("member_id", memberId)
    .maybeSingle();

  let patternId = pattern?.id as string | undefined;
  if (!patternId) {
    const { data: created } = await supabase
      .from("meal_patterns")
      .insert({ member_id: memberId })
      .select("id")
      .single();
    patternId = created?.id;
  }
  if (patternId) {
    await supabase.from("meal_pattern_slots").upsert(
      {
        pattern_id: patternId,
        meal_type: input.mealType,
        availability: input.enabled ? "ENABLED" : "DISABLED",
        is_first_meal: input.isFirstMeal,
        salad_preference: input.saladPreference,
      },
      { onConflict: "pattern_id,meal_type" },
    );
    if (input.isFirstMeal) {
      await supabase
        .from("meal_pattern_slots")
        .update({ is_first_meal: false })
        .eq("pattern_id", patternId)
        .neq("meal_type", input.mealType);
      await supabase
        .from("meal_patterns")
        .update({ first_meal_type: input.mealType })
        .eq("id", patternId);
    }
  }

  await republishProfile(supabase, memberId, memberName, `Objetivos de ${input.mealType}`);
  revalidatePath(`/family/${memberId}`);
  revalidatePath("/recipes");
  return { ok: true, message: "Tu perfil nutricional fue actualizado." };
}

export async function setAddedFatStance(
  memberId: string,
  memberName: string,
  stance: "AVOID" | "ALLOWED" | "PREFERRED",
): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase
    .from("member_added_fat_preferences")
    .upsert({ member_id: memberId, stance }, { onConflict: "member_id" });
  if (error) return { ok: false, error: "No se pudo guardar la preferencia." };

  await republishProfile(supabase, memberId, memberName, "Preferencia de grasa añadida");
  revalidatePath(`/family/${memberId}`);
  return { ok: true, message: "Tu perfil nutricional fue actualizado." };
}

/** Carga la familia de demostración del Sprint 4 en el hogar actual. */
export async function loadDemoFamily(householdId: string): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("seed_demo_family_profiles", {
    p_household_id: householdId,
  });
  if (error) {
    return { ok: false, error: `No se pudo cargar la familia de demostración: ${error.message}` };
  }
  revalidatePath("/family");
  revalidatePath("/recipes");
  return { ok: true, message: "Familia de demostración cargada. Todo es editable." };
}
