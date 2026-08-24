"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { effectiveDate } from "@/domain/nutrition/calendar";
import { applyEventEffect, effectFor } from "@/domain/nutrition/events";
import { effectiveMealTargets } from "@/domain/nutrition/profile";
import type { TargetSet } from "@/domain/nutrition/types";
import { projectFamilyServings } from "@/domain/portions/family";
import type {
  AcceptedSubstitution,
  AvailableAlternative,
  PortionComponent,
} from "@/domain/portions/optimizer";
import type { MealType } from "@/domain/recipes/types";
import { loadDailyOverride, loadHouseholdProfiles } from "@/app/family/nutrition-queries";
import { loadAlternativesWithFacts, loadRecipeDetail } from "@/app/recipes/queries";
import { loadEventsForDate } from "./queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { DataShapeError, dateString } from "@/lib/supabase/rows";
import { z } from "zod";

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

/**
 * Quiénes comen esta comida (§2 del QA adversarial).
 *
 * Una lista vacía NO significa "no come nadie": significa "comen todos", que es
 * el caso normal y no merece cinco filas por almuerzo. Se guardan filas solo
 * cuando alguien queda fuera — el sábado que Francisco tiene un cumpleaños.
 */
export async function setMealParticipants(
  assignmentId: string,
  memberIds: string[],
): Promise<ActionResult> {
  const supabase = await client();

  const { data: yaServidas, error: servidasError } = await supabase
    .from("member_serving_projections")
    .select("id, status")
    .eq("assignment_id", assignmentId)
    .in("status", ["SERVED", "CONSUMED"]);
  if (servidasError) throw new DataAccessError("porciones de la comida", servidasError);
  if ((yaServidas ?? []).length > 0) {
    return { ok: false, error: "Esta comida ya se sirvió: sus porciones son historia." };
  }

  const { error: borrado } = await supabase
    .from("meal_assignment_participants")
    .delete()
    .eq("assignment_id", assignmentId);
  if (borrado) return { ok: false, error: "No se pudo actualizar quiénes comen." };

  if (memberIds.length > 0) {
    const { error } = await supabase
      .from("meal_assignment_participants")
      .insert(memberIds.map((member_id) => ({ assignment_id: assignmentId, member_id })));
    if (error) return { ok: false, error: "No se pudo actualizar quiénes comen." };
  }

  // Las porciones planificadas dejaron de corresponder: se rehacen al confirmar.
  // Si esta limpieza falla hay que decirlo: quedarían guardadas porciones de
  // gente que ya no come, y el ShoppingEngine compraría para ellas.
  const { error: limpieza } = await supabase
    .from("member_serving_projections")
    .delete()
    .eq("assignment_id", assignmentId)
    .eq("status", "PLANNED");
  if (limpieza) throw new DataAccessError("porciones a rehacer", limpieza);

  const { error: reset } = await supabase
    .from("meal_assignments")
    .update({ status: "PLANNED", confirmed_at: null, confirmed_by: null })
    .eq("id", assignmentId)
    .neq("status", "SERVED");
  if (reset) throw new DataAccessError("estado de la comida", reset);

  revalidatePath("/plan");
  return {
    ok: true,
    message: memberIds.length === 0 ? "Vuelve a comer toda la familia." : "Listo, quedó anotado quién come.",
  };
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

  // §6: `plan_date` es DATE-only. Se valida y se normaliza a `YYYY-MM-DD` con el
  // mismo schema que el resto de la capa de datos — nunca se castea. Si llegara
  // como Date, leerlo directo movería la comida un día y la porción quedaría
  // guardada con la fecha equivocada.
  const diaSchema = z.union([
    z.array(z.object({ plan_date: dateString })),
    z.object({ plan_date: dateString }),
    z.null(),
  ]);
  const diaParseado = diaSchema.safeParse(asignacion.weekly_plan_days);
  if (!diaParseado.success) {
    throw new DataShapeError("día de la comida a confirmar", diaParseado.error.issues);
  }
  const dia = diaParseado.data;
  const fecha = (Array.isArray(dia) ? (dia[0]?.plan_date ?? null) : (dia?.plan_date ?? null)) ?? null;

  const recipe = await loadRecipeDetail(supabase, asignacion.template_id, asignacion.version_id);
  if (!recipe) return { ok: false, error: "No se encontró la receta de esa comida." };

  const todosLosPerfiles = await loadHouseholdProfiles(supabase);
  if (todosLosPerfiles.length === 0) return { ok: false, error: "El hogar no tiene integrantes." };

  // §2: solo come quien participa. Sin filas de participantes, comen todos.
  const { data: participantesFilas, error: participantesError } = await supabase
    .from("meal_assignment_participants")
    .select("member_id")
    .eq("assignment_id", assignmentId);
  if (participantesError) throw new DataAccessError("participantes de la comida", participantesError);
  const participantes = (participantesFilas ?? []).map((f) => f.member_id as string);
  const profiles =
    participantes.length === 0
      ? todosLosPerfiles
      : todosLosPerfiles.filter((p) => participantes.includes(p.memberId));

  if (profiles.length === 0) {
    return { ok: false, error: "Nadie come esta comida: marca al menos a una persona." };
  }

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

  // Alternativas con su ficha, en la MISMA lectura validada que usa la pantalla
  // de porciones: una sola fuente, un solo lugar donde equivocarse.
  const alternatives: AvailableAlternative[] = await loadAlternativesWithFacts(
    supabase,
    recipe.alternatives,
  );

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

  // §5: los eventos de ese día dejan de ser decorativos. La estrategia cambia
  // los objetivos de verdad, y solo para las personas que el evento nombra.
  const eventos = await loadEventsForDate(supabase, fechaEfectiva);

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

      // El override que recibe el motor ya trae, en este orden: el patrón de la
      // persona, su excepción del día si tiene, y encima el efecto del evento.
      const base = effectiveMealTargets(
        profile,
        mealType,
        overrides.get(profile.memberId)?.targets ?? null,
      );
      const efecto = effectFor(eventos, profile.memberId, fechaEfectiva, mealType);
      const conEvento = applyEventEffect(base, efecto);

      return {
        profile,
        resolvedTargets: conEvento,
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
  /** Último día inclusive de un evento de varios días. Vacío = un solo día. */
  endDate?: string | null;
  eventType: string;
  mealType: MealType | null;
  strategy: string;
  title: string;
  /** A quiénes afecta. Vacío = a toda la familia. */
  memberIds?: string[];
}): Promise<ActionResult> {
  const supabase = await client();
  if (!input.title.trim()) return { ok: false, error: "El evento necesita un nombre." };
  if (input.endDate && input.endDate < input.date) {
    return { ok: false, error: "El evento no puede terminar antes de empezar." };
  }

  const { data: creado, error } = await supabase
    .from("nutrition_events")
    .insert({
      household_id: input.householdId,
      event_date: input.date,
      end_date: input.endDate || null,
      event_type: input.eventType,
      meal_type: input.mealType,
      strategy: input.strategy,
      title: input.title.trim(),
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: "No se pudo guardar el evento." };

  const memberIds = input.memberIds ?? [];
  if (memberIds.length > 0) {
    const { error: miembrosError } = await supabase
      .from("nutrition_event_members")
      .insert(memberIds.map((member_id) => ({ event_id: creado.id, member_id })));
    if (miembrosError) {
      // Un evento que dice ser de toda la familia cuando era de una persona
      // cambia las porciones de todos: mejor no dejarlo a medias.
      await supabase.from("nutrition_events").delete().eq("id", creado.id);
      return { ok: false, error: "No se pudo guardar a quiénes afecta el evento." };
    }
  }

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
