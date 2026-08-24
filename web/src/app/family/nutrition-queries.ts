import type { SupabaseClient } from "@supabase/supabase-js";
import { buildProfile, type ProfileInputs } from "@/domain/nutrition/profile";
import type {
  AddedFatStance,
  CookingPreference,
  MealPattern,
  MemberNutritionProfile,
  MemberPreference,
  TrackingMode,
} from "@/domain/nutrition/types";
import type { MealType } from "@/domain/recipes/types";

type Db = SupabaseClient;

export interface MemberSummary {
  id: string;
  displayName: string;
  isMe: boolean;
}

/**
 * Carga el perfil nutricional efectivo de un integrante y lo arma con el motor
 * de dominio. Lo que se guarda en `member_nutrition_profiles` es el snapshot;
 * la fuente son estas tablas.
 */
export async function loadMemberProfile(
  db: Db,
  memberId: string,
  memberName: string,
): Promise<MemberNutritionProfile> {
  const [tracking, goals, pattern, preferences, cooking, fat, snapshot] = await Promise.all([
    db.from("member_tracking_settings").select("mode").eq("member_id", memberId).maybeSingle(),
    db
      .from("nutrition_goals")
      .select("goal_type, scope, meal_type, minimum, preferred, maximum, priority")
      .eq("member_id", memberId)
      .eq("status", "ACTIVE"),
    db
      .from("meal_patterns")
      .select(
        `uses_fasting_pattern, first_meal_type, feeding_window_start, feeding_window_end,
         meal_pattern_slots ( meal_type, availability, is_first_meal, salad_preference, priority, sort_order )`,
      )
      .eq("member_id", memberId)
      .maybeSingle(),
    db
      .from("member_preferences")
      .select("preference_type, target_kind, target_id")
      .eq("member_id", memberId),
    db
      .from("member_cooking_preferences")
      .select("ingredient_id, category_id, cooking_method, stance")
      .eq("member_id", memberId),
    db.from("member_added_fat_preferences").select("stance").eq("member_id", memberId).maybeSingle(),
    db
      .from("member_nutrition_profiles")
      .select("id, version")
      .eq("member_id", memberId)
      .eq("is_current", true)
      .maybeSingle(),
  ]);

  const slots = (pattern.data?.meal_pattern_slots ?? []) as {
    meal_type: MealType;
    availability: "ENABLED" | "DISABLED" | "OPTIONAL";
    is_first_meal: boolean;
    salad_preference: "PREFERRED" | "NEUTRAL" | "AVOID";
    priority: number;
    sort_order: number;
  }[];

  const mealPattern: MealPattern = {
    usesFastingPattern: pattern.data?.uses_fasting_pattern ?? false,
    firstMealType: (pattern.data?.first_meal_type as MealType | null) ?? null,
    feedingWindowStart: pattern.data?.feeding_window_start ?? null,
    feedingWindowEnd: pattern.data?.feeding_window_end ?? null,
    meals: [...slots]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({
        mealType: s.meal_type,
        availability: s.availability,
        isFirstMeal: s.is_first_meal,
        saladPreference: s.salad_preference,
        priority: s.priority,
      })),
  };

  const inputs: ProfileInputs = {
    memberId,
    memberName,
    trackingMode: (tracking.data?.mode as TrackingMode) ?? "OFF",
    goals: (goals.data ?? []).map((g) => ({
      goalType: g.goal_type,
      scope: g.scope,
      mealType: g.meal_type,
      minimum: g.minimum === null ? null : Number(g.minimum),
      preferred: g.preferred === null ? null : Number(g.preferred),
      maximum: g.maximum === null ? null : Number(g.maximum),
      priority: g.priority,
    })),
    pattern: mealPattern,
    preferences: (preferences.data ?? []) as unknown as MemberPreference[],
    cookingPreferences: (cooking.data ?? []).map((c) => ({
      ingredientId: c.ingredient_id,
      categoryId: c.category_id,
      cookingMethod: c.cooking_method,
      stance: c.stance,
    })) as CookingPreference[],
    addedFatStance: (fat.data?.stance as AddedFatStance) ?? "ALLOWED",
  };

  const profile = buildProfile(inputs);
  return {
    ...profile,
    profileId: snapshot.data?.id ?? null,
    version: snapshot.data?.version ?? 0,
  };
}

/** Integrantes del hogar del usuario, con "yo" marcado. */
export async function loadHouseholdMembers(db: Db): Promise<{
  householdId: string | null;
  members: MemberSummary[];
}> {
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { householdId: null, members: [] };

  const { data: me } = await db
    .from("household_members")
    .select("id, household_id")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (!me) return { householdId: null, members: [] };

  const { data } = await db
    .from("household_members")
    .select("id, display_name")
    .eq("household_id", me.household_id)
    .eq("is_active", true)
    .order("display_name");

  return {
    householdId: me.household_id,
    members: (data ?? []).map((m) => ({
      id: m.id,
      displayName: m.display_name,
      isMe: m.id === me.id,
    })),
  };
}

/** Todos los perfiles del hogar, para proyectar una comida familiar. */
export async function loadHouseholdProfiles(db: Db): Promise<MemberNutritionProfile[]> {
  const { members } = await loadHouseholdMembers(db);
  return Promise.all(members.map((m) => loadMemberProfile(db, m.id, m.displayName)));
}

/**
 * Excepción del día de una persona, si la tiene (§19). Se lee aparte del perfil
 * porque no forma parte del patrón habitual: lo pisa solo ese día.
 */
export async function loadDailyOverride(
  db: Db,
  memberId: string,
  date: string,
  mealType: MealType,
): Promise<{ planId: string; targets: Record<string, unknown> } | null> {
  const { data } = await db
    .from("member_daily_nutrition_plans")
    .select(
      `id, member_daily_plan_meals ( meal_type, enabled, energy_min, energy_preferred, energy_max,
       protein_min, protein_preferred, protein_max )`,
    )
    .eq("member_id", memberId)
    .eq("plan_date", date)
    .maybeSingle();
  if (!data) return null;

  const meals = (data.member_daily_plan_meals ?? []) as {
    meal_type: MealType;
    energy_min: number | null;
    energy_preferred: number | null;
    energy_max: number | null;
    protein_min: number | null;
    protein_preferred: number | null;
    protein_max: number | null;
  }[];
  const meal = meals.find((m) => m.meal_type === mealType);
  if (!meal) return null;

  const targets: Record<string, unknown> = {};
  if (meal.energy_min !== null || meal.energy_preferred !== null || meal.energy_max !== null) {
    targets.ENERGY_KCAL = {
      minimum: meal.energy_min,
      preferred: meal.energy_preferred,
      maximum: meal.energy_max,
    };
  }
  if (meal.protein_min !== null || meal.protein_preferred !== null || meal.protein_max !== null) {
    targets.PROTEIN_G = {
      minimum: meal.protein_min,
      preferred: meal.protein_preferred,
      maximum: meal.protein_max,
    };
  }
  return { planId: data.id, targets };
}
