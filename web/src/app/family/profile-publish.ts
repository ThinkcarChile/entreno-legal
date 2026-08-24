import type { SupabaseClient } from "@supabase/supabase-js";
import type { MemberNutritionProfile } from "@/domain/nutrition/types";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { loadMemberProfile } from "./nutrition-queries";

/**
 * Publica el snapshot del perfil de una persona.
 *
 * Vive fuera de `nutrition-actions.ts` porque ese módulo es `"use server"` y
 * todo lo que exporta se vuelve un endpoint. Esto no es una acción del usuario:
 * es una operación interna que también necesita la confirmación de una comida.
 *
 * `publish_nutrition_profile` deduplica por firma de entradas, así que llamarlo
 * de más no crea versiones nuevas: si nada cambió, devuelve el snapshot vigente.
 */
export async function publishProfileSnapshot(
  db: SupabaseClient,
  memberId: string,
  memberName: string,
  reason: string,
): Promise<MemberNutritionProfile> {
  const profile = await loadMemberProfile(db, memberId, memberName);
  const { error } = await db.rpc("publish_nutrition_profile", {
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
  if (error) throw new DataAccessError("publicación del perfil nutricional", error);

  // Se relee para devolver el perfil YA con su `profileId`: es el dato que se
  // guarda junto a cada porción para poder responder con qué perfil se calculó.
  return loadMemberProfile(db, memberId, memberName);
}
