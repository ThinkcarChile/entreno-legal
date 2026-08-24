"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import {
  USER_SETTABLE_PREFERENCES,
  type GoalType,
  type TrackingMode,
  type UserSettablePreference,
} from "@/domain/nutrition/types";
import type { MealType } from "@/domain/recipes/types";
import { publishProfileSnapshot } from "./profile-publish";
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
  await publishProfileSnapshot(supabase, memberId, memberName, reason);
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
  const { data: pattern, error: errorPattern } = await supabase
    .from("meal_patterns")
    .select("id")
    .eq("member_id", memberId)
    .maybeSingle();
  if (errorPattern) throw new DataAccessError("patron de comidas", errorPattern);

  let patternId = pattern?.id as string | undefined;
  if (!patternId) {
    const { data: created, error: errorCreated } = await supabase
      .from("meal_patterns")
      .insert({ member_id: memberId })
      .select("id")
      .single();
    if (errorCreated) throw new DataAccessError("creacion del patron de comidas", errorCreated);
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

// ---------------------------------------------------------------------------
// QA §27 — Preferencias de alimentos y de preparación
// ---------------------------------------------------------------------------

/**
 * Tipos que una persona puede fijarse a sí misma. `MEDICAL_RESTRICTION` no está
 * y no va a estar: nace del pipeline clínico, y la base lo bloquea además de la
 * interfaz.
 */
export async function setIngredientPreference(
  memberId: string,
  memberName: string,
  ingredientId: string,
  preferenceType: UserSettablePreference | "REMOVE",
): Promise<ActionResult> {
  const supabase = await client();

  if (preferenceType !== "REMOVE" && !USER_SETTABLE_PREFERENCES.includes(preferenceType)) {
    return { ok: false, error: "Ese tipo de preferencia no se fija desde la aplicación." };
  }

  if (preferenceType === "REMOVE") {
    const { error } = await supabase
      .from("member_preferences")
      .delete()
      .eq("member_id", memberId)
      .eq("target_kind", "INGREDIENT")
      .eq("target_id", ingredientId);
    if (error) {
      return {
        ok: false,
        error: error.message.includes("restricción médica")
          ? "Una restricción médica no se elimina desde acá."
          : "No se pudo quitar la preferencia.",
      };
    }
  } else {
    const { error } = await supabase.from("member_preferences").upsert(
      {
        member_id: memberId,
        preference_type: preferenceType,
        target_kind: "INGREDIENT",
        target_id: ingredientId,
      },
      { onConflict: "member_id,target_kind,target_id" },
    );
    if (error) {
      return {
        ok: false,
        error: error.message.includes("restricción médica")
          ? "Esa restricción es médica y no se cambia desde acá."
          : "No se pudo guardar la preferencia.",
      };
    }
  }

  await republishProfile(supabase, memberId, memberName, "Preferencias de alimentos");
  revalidatePath(`/family/${memberId}`);
  return { ok: true, message: "Tu perfil nutricional fue actualizado." };
}

export interface CookingPreferenceInput {
  /** Exactamente uno, o ninguno para la regla global (§14). */
  ingredientId?: string | null;
  categoryId?: string | null;
  cookingMethod: string;
  stance: "PREFERRED" | "ACCEPTED" | "AVOID";
}

export async function setCookingPreference(
  memberId: string,
  memberName: string,
  input: CookingPreferenceInput,
): Promise<ActionResult> {
  const supabase = await client();

  if (input.ingredientId && input.categoryId) {
    return { ok: false, error: "Una preferencia apunta a un alimento o a una categoría, no a ambos." };
  }

  const { error } = await supabase.from("member_cooking_preferences").upsert(
    {
      member_id: memberId,
      ingredient_id: input.ingredientId ?? null,
      category_id: input.categoryId ?? null,
      cooking_method: input.cookingMethod,
      stance: input.stance,
    },
    { onConflict: "member_id,ingredient_id,category_id,cooking_method" },
  );
  if (error) return { ok: false, error: "No se pudo guardar la preferencia de preparación." };

  await republishProfile(supabase, memberId, memberName, "Preferencias de preparación");
  revalidatePath(`/family/${memberId}`);
  return { ok: true, message: "Tu perfil nutricional fue actualizado." };
}

export async function removeCookingPreference(
  memberId: string,
  memberName: string,
  preferenceId: string,
): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase
    .from("member_cooking_preferences")
    .delete()
    .eq("id", preferenceId)
    .eq("member_id", memberId);
  if (error) return { ok: false, error: "No se pudo quitar la preferencia." };

  await republishProfile(supabase, memberId, memberName, "Preferencias de preparación");
  revalidatePath(`/family/${memberId}`);
  return { ok: true, message: "Tu perfil nutricional fue actualizado." };
}

// ---------------------------------------------------------------------------
// QA §28 — Excepción de un solo día
// ---------------------------------------------------------------------------

export interface DailyOverrideInput {
  date: string; // YYYY-MM-DD en la zona del hogar
  mealType: MealType;
  enabled: boolean;
  energyMax: number | null;
  proteinMin: number | null;
  proteinPreferred: number | null;
  proteinMax: number | null;
  note?: string | null;
}

/** La excepción vive aparte: no toca el patrón habitual (§19). */
export async function saveDailyOverride(
  memberId: string,
  input: DailyOverrideInput,
): Promise<ActionResult> {
  const supabase = await client();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return { ok: false, error: "Fecha inválida." };
  }
  if (input.proteinMin !== null && input.proteinMax !== null && input.proteinMin > input.proteinMax) {
    return { ok: false, error: "El mínimo de proteína no puede ser mayor que el máximo." };
  }

  const { data: plan, error: planError } = await supabase
    .from("member_daily_nutrition_plans")
    .upsert(
      { member_id: memberId, plan_date: input.date, note: input.note ?? null },
      { onConflict: "member_id,plan_date" },
    )
    .select("id")
    .single();
  if (planError || !plan) return { ok: false, error: "No se pudo crear la excepción del día." };

  const { error } = await supabase.from("member_daily_plan_meals").upsert(
    {
      plan_id: plan.id,
      meal_type: input.mealType,
      enabled: input.enabled,
      energy_max: input.energyMax,
      protein_min: input.proteinMin,
      protein_preferred: input.proteinPreferred,
      protein_max: input.proteinMax,
    },
    { onConflict: "plan_id,meal_type" },
  );
  if (error) return { ok: false, error: "No se pudo guardar la excepción." };

  revalidatePath(`/family/${memberId}`);
  revalidatePath("/recipes");
  return { ok: true, message: `Excepción guardada solo para el ${input.date}.` };
}

/** Volver al patrón habitual: se borra la excepción, no se "reescribe". */
export async function clearDailyOverride(
  memberId: string,
  date: string,
): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase
    .from("member_daily_nutrition_plans")
    .delete()
    .eq("member_id", memberId)
    .eq("plan_date", date);
  if (error) return { ok: false, error: "No se pudo restaurar el patrón habitual." };

  revalidatePath(`/family/${memberId}`);
  revalidatePath("/recipes");
  return { ok: true, message: "Volviste a tu patrón habitual." };
}

/**
 * QA §29 — El nombre del hogar y el de una persona son cosas distintas, y hasta
 * ahora no había forma de corregir el segundo. Si alguien escribió "Casa" en
 * "Tu nombre" al crear el hogar, quedaba así para siempre.
 */
export async function renameMember(memberId: string, displayName: string): Promise<ActionResult> {
  const nombre = displayName.trim();
  if (nombre.length < 1 || nombre.length > 80) {
    return { ok: false, error: "El nombre debe tener entre 1 y 80 caracteres." };
  }

  const supabase = await client();
  const { error } = await supabase
    .from("household_members")
    .update({ display_name: nombre, updated_at: new Date().toISOString() })
    .eq("id", memberId);
  if (error) return { ok: false, error: "No se pudo cambiar el nombre." };

  revalidatePath(`/family/${memberId}`);
  revalidatePath("/family");
  revalidatePath("/recipes");
  return { ok: true, message: `Ahora se llama ${nombre}.` };
}
