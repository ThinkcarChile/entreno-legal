import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { buildProfile, type ProfileInputs } from "@/domain/nutrition/profile";
import type {
  CookingPreference,
  MealPattern,
  MemberNutritionProfile,
  MemberPreference,
} from "@/domain/nutrition/types";
import type { MealType } from "@/domain/recipes/types";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { dateString, nullableNumeric, parseMaybeRow, parseRows, uuid } from "@/lib/supabase/rows";
import { z } from "zod";

/**
 * Schemas del perfil. Este es exactamente el módulo donde un `as unknown as`
 * hizo que el optimizador ignorara todas las preferencias: la base devuelve
 * snake_case, el dominio lee camelCase, y el casteo no se quejó nunca.
 */
const trackingSchema = z.object({ mode: z.enum(["OFF", "BASIC", "FULL"]) });

const goalRowSchema = z.object({
  goal_type: z.enum(["ENERGY_KCAL", "PROTEIN_G", "CARBOHYDRATE_G", "FAT_G", "FIBER_G"]),
  scope: z.enum(["DAILY", "PER_MEAL"]),
  meal_type: z.string().nullable(),
  minimum: nullableNumeric,
  preferred: nullableNumeric,
  maximum: nullableNumeric,
  priority: z.number().int(),
});

const patternSlotSchema = z.object({
  meal_type: z.string(),
  availability: z.enum(["ENABLED", "DISABLED", "OPTIONAL"]),
  is_first_meal: z.boolean(),
  salad_preference: z.enum(["PREFERRED", "NEUTRAL", "AVOID"]),
  priority: z.number().int(),
  sort_order: z.number().int(),
});

const manySlots = z
  .union([z.array(patternSlotSchema), patternSlotSchema, z.null()])
  .transform((v) => (v === null ? [] : Array.isArray(v) ? v : [v]));

const patternSchema = z.object({
  uses_fasting_pattern: z.boolean(),
  first_meal_type: z.string().nullable(),
  feeding_window_start: z.string().nullable(),
  feeding_window_end: z.string().nullable(),
  meal_pattern_slots: manySlots,
});

const preferenceRowSchema = z.object({
  preference_type: z.enum([
    "FAVORITE", "LIKE", "NEUTRAL", "DISLIKE", "AVOID",
    "INTOLERANCE", "ALLERGY", "MEDICAL_RESTRICTION",
  ]),
  target_kind: z.enum(["INGREDIENT", "CATEGORY", "MEAL_TEMPLATE", "PRODUCT"]),
  target_id: uuid,
});

const cookingRowSchema = z.object({
  ingredient_id: uuid.nullable(),
  category_id: uuid.nullable(),
  cooking_method: z.string(),
  stance: z.enum(["PREFERRED", "ACCEPTED", "AVOID"]),
});

const fatSchema = z.object({ stance: z.enum(["AVOID", "ALLOWED", "PREFERRED"]) });

const snapshotSchema = z.object({ id: uuid, version: z.number().int() });

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

  // Siete consultas en paralelo: si una falla en silencio, el perfil sale
  // incompleto y el optimizador calcula una porción EQUIVOCADA, que es mucho
  // peor que una pantalla vacía. Ninguna puede pasar sin revisar.
  const partes: [string, { error: PostgrestError | null }][] = [
    ["seguimiento", tracking],
    ["objetivos", goals],
    ["patron de comidas", pattern],
    ["preferencias", preferences],
    ["preferencias de coccion", cooking],
    ["preferencia de grasa anadida", fat],
    ["snapshot del perfil", snapshot],
  ];
  for (const [contexto, resultado] of partes) {
    if (resultado.error) throw new DataAccessError(`${contexto} de ${memberName}`, resultado.error);
  }

  return profileFromRows(
    {
      tracking: tracking.data,
      goals: goals.data,
      pattern: pattern.data,
      preferences: preferences.data,
      cooking: cooking.data,
      fat: fat.data,
      snapshot: snapshot.data,
    },
    memberId,
    memberName,
  );
}

/** Filas crudas tal como las devuelve la base, sin interpretar. */
export interface ProfileRows {
  tracking: unknown;
  goals: unknown;
  pattern: unknown;
  preferences: unknown;
  cooking: unknown;
  fat: unknown;
  snapshot: unknown;
}

/**
 * Construye el perfil a partir de filas crudas. Es una función PURA a propósito:
 * es la costura exacta donde vivía el bug crítico del Sprint 4, y así se puede
 * probar contra filas reales de PostgreSQL sin levantar la aplicación entera.
 */
export function profileFromRows(
  rows: ProfileRows,
  memberId: string,
  memberName: string,
): MemberNutritionProfile {
  const patternRow = parseMaybeRow(patternSchema, rows.pattern, `patrón de ${memberName}`);

  const mealPattern: MealPattern = {
    usesFastingPattern: patternRow?.uses_fasting_pattern ?? false,
    firstMealType: (patternRow?.first_meal_type as MealType | null) ?? null,
    feedingWindowStart: patternRow?.feeding_window_start ?? null,
    feedingWindowEnd: patternRow?.feeding_window_end ?? null,
    meals: [...(patternRow?.meal_pattern_slots ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({
        mealType: s.meal_type as MealType,
        availability: s.availability,
        isFirstMeal: s.is_first_meal,
        saladPreference: s.salad_preference,
        priority: s.priority,
      })),
  };

  const inputs: ProfileInputs = {
    memberId,
    memberName,
    trackingMode:
      parseMaybeRow(trackingSchema, rows.tracking, `seguimiento de ${memberName}`)?.mode ?? "OFF",
    goals: parseRows(goalRowSchema, rows.goals, `objetivos de ${memberName}`).map((g) => ({
      goalType: g.goal_type,
      scope: g.scope,
      mealType: g.meal_type as MealType | null,
      minimum: g.minimum,
      preferred: g.preferred,
      maximum: g.maximum,
      priority: g.priority,
    })),
    pattern: mealPattern,
    // Validadas y mapeadas, nunca casteadas: acá es donde un cast dejó todas las
    // preferencias con claves que el optimizador jamás leyó, y una alergia dejó
    // de bloquear el plato sin que nada avisara.
    preferences: parseRows(
      preferenceRowSchema,
      rows.preferences,
      `preferencias de ${memberName}`,
    ).map(
      (p): MemberPreference => ({
        preferenceType: p.preference_type,
        targetKind: p.target_kind,
        targetId: p.target_id,
      }),
    ),
    cookingPreferences: parseRows(
      cookingRowSchema,
      rows.cooking,
      `preferencias de cocción de ${memberName}`,
    ).map(
      (c): CookingPreference => ({
        ingredientId: c.ingredient_id,
        categoryId: c.category_id,
        cookingMethod: c.cooking_method,
        stance: c.stance,
      }),
    ),
    addedFatStance:
      parseMaybeRow(fatSchema, rows.fat, `grasa añadida de ${memberName}`)?.stance ?? "ALLOWED",
  };

  const snapshotRow = parseMaybeRow(snapshotSchema, rows.snapshot, `perfil de ${memberName}`);
  const profile = buildProfile(inputs);
  return {
    ...profile,
    profileId: snapshotRow?.id ?? null,
    version: snapshotRow?.version ?? 0,
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

  const { data: me, error: err1Me } = await db
    .from("household_members")
    .select("id, household_id")
    .eq("user_id", user.id)
    .eq("is_active", true)
    // Determinista para quien pertenece a más de un hogar: siempre el más
    // antiguo, no el que el planificador de la base quiera devolver hoy.
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (err1Me) throw new DataAccessError("integrante del usuario", err1Me);
  if (!me) return { householdId: null, members: [] };

  const { data, error: err1Data } = await db
    .from("household_members")
    .select("id, display_name")
    .eq("household_id", me.household_id)
    .eq("is_active", true)
    .order("display_name");
  if (err1Data) throw new DataAccessError("integrantes del hogar", err1Data);

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
  const { data, error: err2Data } = await db
    .from("member_daily_nutrition_plans")
    .select(
      `id, member_daily_plan_meals ( meal_type, enabled, energy_min, energy_preferred, energy_max,
       protein_min, protein_preferred, protein_max )`,
    )
    .eq("member_id", memberId)
    .eq("plan_date", date)
    .maybeSingle();
  if (err2Data) throw new DataAccessError("excepcion del dia", err2Data);
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

// ---------------------------------------------------------------------------
// QA §27 — Datos para editar preferencias
// ---------------------------------------------------------------------------

export interface PreferenceContext {
  ingredients: { id: string; name: string; categoryId: string | null }[];
  categories: { id: string; name: string }[];
  /** Preferencias de alimentos con nombre, no con uuid. */
  foodPreferences: {
    ingredientId: string;
    label: string;
    preferenceType: string;
    /** Las médicas se muestran pero no se editan. */
    editable: boolean;
  }[];
  cookingPreferences: {
    id: string;
    ingredientId: string | null;
    categoryId: string | null;
    label: string;
    cookingMethod: string;
    stance: string;
  }[];
}

export async function loadPreferenceContext(
  db: Db,
  memberId: string,
): Promise<PreferenceContext> {
  const [ingredients, categories, prefs, cooking] = await Promise.all([
    db.from("ingredients").select("id, display_name, category_id").eq("is_active", true).order("display_name"),
    db.from("ingredient_categories").select("id, name").order("sort_order"),
    db
      .from("member_preferences")
      // `target_id` es polimórfico (ingrediente, categoría, receta o producto):
      // no tiene clave foránea y por lo tanto no admite embed. El nombre se
      // resuelve con el mapa de ingredientes que ya se está trayendo.
      .select("target_id, preference_type, target_kind")
      .eq("member_id", memberId)
      .eq("target_kind", "INGREDIENT"),
    db
      .from("member_cooking_preferences")
      .select("id, ingredient_id, category_id, cooking_method, stance")
      .eq("member_id", memberId),
  ]);

  for (const [contexto, resultado] of [
    ["alimentos", ingredients],
    ["categorias", categories],
    ["preferencias de alimentos", prefs],
    ["preferencias de coccion", cooking],
  ] as [string, { error: PostgrestError | null }][]) {
    if (resultado.error) throw new DataAccessError(contexto, resultado.error);
  }

  const byIngredient = new Map((ingredients.data ?? []).map((i) => [i.id, i.display_name]));
  const byCategory = new Map((categories.data ?? []).map((c) => [c.id, c.name]));

  return {
    ingredients: (ingredients.data ?? []).map((i) => ({
      id: i.id,
      name: i.display_name,
      categoryId: i.category_id,
    })),
    categories: (categories.data ?? []).map((c) => ({ id: c.id, name: c.name })),
    foodPreferences: (prefs.data ?? []).map((p) => ({
      ingredientId: p.target_id,
      label: byIngredient.get(p.target_id) ?? "Alimento",
      preferenceType: p.preference_type,
      editable: p.preference_type !== "MEDICAL_RESTRICTION",
    })),
    cookingPreferences: (cooking.data ?? []).map((c) => ({
      id: c.id,
      ingredientId: c.ingredient_id,
      categoryId: c.category_id,
      label: c.ingredient_id
        ? (byIngredient.get(c.ingredient_id) ?? "Alimento")
        : c.category_id
          ? (byCategory.get(c.category_id) ?? "Categoría")
          : "Todos los alimentos",
      cookingMethod: c.cooking_method,
      stance: c.stance,
    })),
  };
}

/** Excepciones del día ya guardadas para un integrante, de hoy en adelante. */
export async function loadUpcomingOverrides(
  db: Db,
  memberId: string,
  fromDate: string,
): Promise<{ date: string; meals: { mealType: MealType; energyMax: number | null }[] }[]> {
  const { data, error } = await db
    .from("member_daily_nutrition_plans")
    .select(`plan_date, member_daily_plan_meals ( meal_type, energy_max )`)
    .eq("member_id", memberId)
    .gte("plan_date", fromDate)
    .order("plan_date");
  if (error) throw new DataAccessError("excepciones del dia", error);

  // §6: `plan_date` es DATE-only y se normaliza con el schema compartido. Antes
  // se leía directo y se castaba el embed: una fila con otra forma se convertía
  // en silencio en una excepción del día incompleta.
  const comida = z.object({ meal_type: z.string(), energy_max: nullableNumeric });
  const filaSchema = z.object({
    plan_date: dateString,
    member_daily_plan_meals: z
      .union([z.array(comida), comida, z.null()])
      .transform((v) => (v === null ? [] : Array.isArray(v) ? v : [v])),
  });

  return parseRows(filaSchema, data, "excepciones del dia").map((plan) => ({
    date: plan.plan_date,
    meals: plan.member_daily_plan_meals.map((m) => ({
      mealType: m.meal_type as MealType,
      energyMax: m.energy_max,
    })),
  }));
}
