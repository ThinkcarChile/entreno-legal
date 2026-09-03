"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { effectiveDate } from "@/domain/nutrition/calendar";
import { applyEventEffect, effectFor, frozenEffectConfig } from "@/domain/nutrition/events";
import { effectiveMealTargets } from "@/domain/nutrition/profile";
import type { TargetSet } from "@/domain/nutrition/types";
import { projectFamilyServings } from "@/domain/portions/family";
import type {
  AcceptedSubstitution,
  AvailableAlternative,
  ClinicalCeiling,
  PortionComponent,
} from "@/domain/portions/optimizer";
import type { MealType } from "@/domain/recipes/types";
import {
  clinicalCeilingsFrom,
  evaluateMeal,
  loadClinicalContext,
  persistMealAssessment,
  type ClinicalContext,
} from "@/app/health/assess-service";
import { loadDailyOverride, loadHouseholdProfiles } from "@/app/family/nutrition-queries";
import { publishProfileSnapshot } from "@/app/family/profile-publish";
import { loadAlternativesWithFacts, loadRecipeDetail } from "@/app/recipes/queries";
import { loadEventsForDate } from "./queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { DataShapeError, dateString, parseRows, uuid } from "@/lib/supabase/rows";
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

  // Gate 0→10 [A-1]: los reemplazos ACEPTADOS son una decisión guardada, no un
  // parámetro que el botón de turno tenga que acordarse de pasar. Antes vivían
  // en un query param de la vista de porciones: quien confirmaba desde la
  // semana los perdía y la porción quedaba con el alimento de la receta —
  // Sebastián terminaba con pollo aunque hubiera aceptado merluza.
  const { data: elegidas, error: elegidasError } = await supabase
    .from("meal_substitution_choices")
    .select("member_id, component_id, to_ingredient_id")
    .eq("assignment_id", assignmentId);
  if (elegidasError) throw new DataAccessError("reemplazos aceptados", elegidasError);
  const elegidasFilas = parseRows(
    z.object({ member_id: uuid, component_id: uuid, to_ingredient_id: uuid }),
    elegidas,
    "reemplazos aceptados",
  );
  const sustituciones: Record<string, { componentId: string; ingredientId: string }[]> = {
    ...substitutionsByMember,
  };
  for (const e of elegidasFilas) {
    const previas = sustituciones[e.member_id] ?? [];
    if (!previas.some((p) => p.componentId === e.component_id)) {
      sustituciones[e.member_id] = [
        ...previas,
        { componentId: e.component_id, ingredientId: e.to_ingredient_id },
      ];
    }
  }
  substitutionsByMember = sustituciones;

  const { data: asignacion, error: asigError } = await supabase
    .from("meal_assignments")
    .select(
      "id, meal_type, version_id, template_id, weekly_plan_days ( plan_date, weekly_plans ( household_id ) )",
    )
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
  const planSchema = z.union([
    z.array(z.object({ household_id: uuid })),
    z.object({ household_id: uuid }),
    z.null(),
  ]);
  const diaSchema = z.union([
    z.array(z.object({ plan_date: dateString, weekly_plans: planSchema })),
    z.object({ plan_date: dateString, weekly_plans: planSchema }),
    z.null(),
  ]);
  const diaParseado = diaSchema.safeParse(asignacion.weekly_plan_days);
  if (!diaParseado.success) {
    throw new DataShapeError("día de la comida a confirmar", diaParseado.error.issues);
  }
  const uno = <T,>(v: T[] | T | null): T | null =>
    v === null ? null : Array.isArray(v) ? (v[0] ?? null) : v;
  const dia = uno(diaParseado.data);
  const fecha = dia?.plan_date ?? null;

  // Gate 0→10 [F-1]: TODO lo que sigue (integrantes, zona horaria, eventos) es
  // del hogar DE ESTA COMIDA. Antes cada lectura elegía hogar por su cuenta —
  // "el más antiguo", "el primero", "todos los míos"— y para quien pertenece a
  // dos casas eso mezclaba familias enteras.
  const householdId = uno(dia?.weekly_plans ?? null)?.household_id ?? null;
  if (!householdId) {
    return { ok: false, error: "Esa comida no está colgada de ningún plan: no se puede confirmar." };
  }

  const recipe = await loadRecipeDetail(supabase, asignacion.template_id, asignacion.version_id);
  if (!recipe) return { ok: false, error: "No se encontró la receta de esa comida." };

  const todosLosPerfiles = await loadHouseholdProfiles(supabase, householdId);
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

  // Quien nunca abrió su ficha no tiene snapshot publicado, y sin snapshot no se
  // puede guardar con qué perfil se calculó su porción. Antes eso bloqueaba la
  // confirmación: una familia recién creada no podía confirmar NINGUNA comida
  // hasta abrir las cinco fichas. Un perfil sin objetivos es un perfil válido —
  // dice "esta persona no lleva conteo" — así que se publica acá mismo. El RPC
  // deduplica por firma: si ya existía y nada cambió, no crea una versión nueva.
  for (let i = 0; i < profiles.length; i += 1) {
    const perfil = profiles[i]!;
    if (perfil.profileId) continue;
    profiles[i] = await publishProfileSnapshot(
      supabase,
      perfil.memberId,
      perfil.memberName,
      "Publicado al confirmar una comida",
    );
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
    productId: c.target.kind === "PRODUCT" ? c.target.productId : null,
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
    .eq("id", householdId)
    .maybeSingle();
  if (hogarError) throw new DataAccessError("zona horaria del hogar", hogarError);
  const fechaEfectiva = fecha ?? effectiveDate(new Date(), hogar?.timezone ?? "America/Santiago");

  const overrides = new Map<string, { planId: string; targets: TargetSet } | null>();
  // Gate 0→10 [H-2]: quien marcó "ese día no almuerzo" no come. Antes la
  // columna `enabled` se leía de la base y se tiraba a la basura, así que la
  // persona igual aparecía servida.
  const seSaltanLaComida: string[] = [];
  for (const profile of profiles) {
    const plan = await loadDailyOverride(supabase, profile.memberId, fechaEfectiva, mealType);
    if (plan && !plan.enabled) {
      seSaltanLaComida.push(profile.memberId);
      continue;
    }
    overrides.set(
      profile.memberId,
      plan ? { planId: plan.planId, targets: plan.targets as TargetSet } : null,
    );
  }
  const comen = profiles.filter((p) => !seSaltanLaComida.includes(p.memberId));
  if (comen.length === 0) {
    return {
      ok: false,
      error: "Nadie come esta comida: todos marcaron que ese día se la saltan.",
    };
  }

  // §5: los eventos de ese día dejan de ser decorativos. La estrategia cambia
  // los objetivos de verdad, y solo para las personas que el evento nombra.
  const eventos = await loadEventsForDate(supabase, fechaEfectiva, householdId);
  const efectosPorMiembro = new Map<string, ReturnType<typeof effectFor>>();

  // --- Techos clínicos ANTES de calcular la porción (§31, ADR 0012) --------
  //
  // Auditoría posterior al Sprint 11.5: `optimizePortion` aceptaba
  // `clinicalCeilings` desde el primer día y NADIE se los pasaba. Una
  // restricción HARD confirmada —un máximo de sodio, un techo de proteína—
  // no capaba en nada la porción que se calculaba y se guardaba. El motor
  // clínico estaba construido, probado… y desconectado.
  //
  // Esta primera pasada es un SCREENING declarado (`assignmentId: null` ⇒
  // fuente RECIPE_BASE_ESTIMATE): todavía no existe la porción de esta
  // persona, así que su veredicto NO se guarda ni se muestra. Lo único que se
  // usa de ella son los techos confirmados, que sí valen igual porque salen
  // de la restricción, no de la nutrición del plato.
  //
  // Si la lectura clínica rebota (sin permiso, base caída, fila deforme) la
  // persona queda anotada en `sinClinica`: su porción se calcula sin techos
  // —no hay con qué— y más abajo se marca REVIEW_REQUIRED. Jamás compatible:
  // UNKNOWN NUNCA SIGNIFICA NORMAL.
  const contextosClinicos = new Map<string, ClinicalContext>();
  const techosPorMiembro = new Map<string, ClinicalCeiling[]>();
  const sinClinica = new Set<string>();
  for (const profile of comen) {
    try {
      const contexto = await loadClinicalContext(supabase, profile.memberId);
      contextosClinicos.set(profile.memberId, contexto);
      const previa = await evaluateMeal(supabase, {
        memberId: profile.memberId,
        versionId: asignacion.version_id,
        assignmentId: null,
        date: fechaEfectiva,
        context: contexto,
      });
      techosPorMiembro.set(profile.memberId, clinicalCeilingsFrom(previa.assessment));
    } catch {
      sinClinica.add(profile.memberId);
    }
  }

  const proyeccion = projectFamilyServings({
    versionId: asignacion.version_id,
    components,
    alternatives,
    baseServings: recipe.baseServings,
    mealType,
    members: comen.map((profile) => {
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
      efectosPorMiembro.set(profile.memberId, efecto);

      return {
        profile,
        resolvedTargets: conEvento,
        substitutions,
        // §31: AI NEVER OVERRIDES CLINICAL RULES — y el objetivo deportivo
        // tampoco. El techo médico entra al cálculo, no al comentario.
        clinicalCeilings: techosPorMiembro.get(profile.memberId),
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
      // Gate final §6 [U-4]: lo que NO se pudo verificar se congela COMO
      // desconocido. Antes se descartaba y la porción quedaba idéntica a una
      // con todos los límites verificados.
      unverifiable_constraints: serving.unverifiableConstraints,
      // §0A: la configuración efectiva del evento queda congelada en la fila.
      event_effect: frozenEffectConfig(
        efectosPorMiembro.get(serving.memberId) ?? { kind: "NONE", event: null, text: "" },
      ),
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
        // §3 del Sprint 6: la identidad REAL (ya con sustitución) se congela.
        ingredient_id: c.ingredientId,
        product_id: c.productId,
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

  const sinPerfil = payload.filter((p) => !p.profile_id).map((p) => p.member_id);
  if (sinPerfil.length > 0) {
    const quienes = sinPerfil
      .map((id) => profiles.find((perfil) => perfil.memberId === id)?.memberName ?? id)
      .join(", ");
    return {
      ok: false,
      error: `No se pudo publicar el perfil nutricional de ${quienes}. Intenta de nuevo.`,
    };
  }

  const { data: guardadas, error } = await supabase.rpc("confirm_meal_assignment", {
    p_assignment_id: assignmentId,
    p_servings: payload,
  });
  if (error) return { ok: false, error: `No se pudo confirmar: ${error.message}` };

  const sinEvaluar = await evaluarPorcionesConfirmadas(supabase, {
    assignmentId,
    versionId: asignacion.version_id,
    date: fechaEfectiva,
    contextos: contextosClinicos,
    sinClinica,
    nombres: new Map(profiles.map((p) => [p.memberId, p.memberName])),
  });

  revalidatePath("/plan");
  const base = `Comida confirmada con ${guardadas} porciones guardadas.`;
  if (sinEvaluar.length === 0) return { ok: true, message: base };
  // La comida QUEDÓ confirmada: decir `ok: false` sería mentir al revés. Lo
  // que falta es el veredicto clínico, y eso se dice con todas sus letras.
  return {
    ok: true,
    message:
      `${base} OJO: la porción de ${sinEvaluar.join(", ")} quedó SIN evaluación clínica ` +
      "(no se pudieron leer sus restricciones). Revísala antes de servir.",
  };
}

/**
 * Veredicto clínico de cada porción recién confirmada (§30/§43).
 *
 * Recién ahora existe la porción de cada persona, así que recién ahora el
 * motor puede hablar de ELLA y no del promedio de la olla: la fuente sube de
 * RECIPE_BASE_ESTIMATE a PROJECTED_MEMBER_SERVING y el "dentro del límite"
 * pasa a valer para esta persona (§1 del cierre v2).
 *
 * Ninguna porción queda en un estado que se pueda confundir con "compatible":
 *  · evaluada → su estado real (COMPATIBLE … CLINICALLY_INVALIDATED);
 *  · no se pudo evaluar pero sí escribir → REVIEW_REQUIRED sin evaluación
 *    asociada (el motivo vive en Salud, no acá);
 *  · no se pudo ni escribir (sin permiso médico) → el estado queda NULO, que
 *    la pantalla y el tablero muestran como SIN EVALUAR, jamás como limpia.
 *
 * Devuelve los nombres de quienes quedaron sin veredicto.
 */
async function evaluarPorcionesConfirmadas(
  supabase: Awaited<ReturnType<typeof client>>,
  input: {
    assignmentId: string;
    versionId: string;
    date: string;
    contextos: Map<string, ClinicalContext>;
    sinClinica: Set<string>;
    nombres: Map<string, string>;
  },
): Promise<string[]> {
  const { data: proyecciones, error: proyError } = await supabase
    .from("member_serving_projections")
    .select("id, member_id")
    .eq("assignment_id", input.assignmentId);
  if (proyError) throw new DataAccessError("porciones recién confirmadas", proyError);
  const filas = parseRows(
    z.object({ id: uuid, member_id: uuid }),
    proyecciones,
    "porciones recién confirmadas",
  );

  const sinEvaluar: string[] = [];
  for (const fila of filas) {
    const nombre = input.nombres.get(fila.member_id) ?? "un integrante";

    // Último recurso: dejar la porción pidiendo revisión humana, sin decir por
    // qué. Si ni esto se puede (quien confirma no tiene acceso médico a esta
    // persona), el estado queda nulo = SIN EVALUAR, que es la verdad.
    const pedirRevision = async (): Promise<void> => {
      const { error } = await supabase.rpc("set_serving_clinical_status", {
        p_projection_id: fila.id,
        p_status: "REVIEW_REQUIRED",
        p_assessment_id: null,
      });
      if (error) sinEvaluar.push(nombre);
    };

    if (input.sinClinica.has(fila.member_id)) {
      await pedirRevision();
      continue;
    }

    try {
      const veredicto = await evaluateMeal(supabase, {
        memberId: fila.member_id,
        versionId: input.versionId,
        assignmentId: input.assignmentId,
        date: input.date,
        context: input.contextos.get(fila.member_id) ?? null,
      });
      const guardada = await persistMealAssessment(supabase, {
        memberId: fila.member_id,
        versionId: input.versionId,
        assignmentId: input.assignmentId,
        evaluacion: veredicto,
      });
      // Guardar es también la comprobación de permiso: el RPC exige el mismo
      // `medical_access` que la RLS de las restricciones. Si rebota, el
      // veredicto se calculó sobre una lectura vacía y se descarta entero.
      if (!guardada.ok) {
        await pedirRevision();
        continue;
      }
      const { error: estadoError } = await supabase.rpc("set_serving_clinical_status", {
        p_projection_id: fila.id,
        p_status: veredicto.assessment.status,
        p_assessment_id: guardada.id,
      });
      if (estadoError) await pedirRevision();
    } catch {
      await pedirRevision();
    }
  }
  return [...new Set(sinEvaluar)];
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
      // Este formulario SÍ pregunta a quién afecta, y su respuesta "ninguno
      // marcado" significa toda la familia — está escrito al lado de las
      // casillas. Se guarda esa lectura explícita en vez de dejar que otro la
      // adivine mirando una lista vacía (0041, member_scope).
      member_scope:
        (input.memberIds ?? []).length > 0 ? "DECLARED_ROSTER" : "LEGACY_EMPTY_MEANS_ALL",
      // EN BORRADOR, Y ESCRITO. Hasta la 0061 este insert no mandaba `status` y
      // se llevaba el default de la 0041, que era 'PLANNED': el evento nacía
      // fuera del borrador y `app.event_history_guard` no lo dejaba borrar NUNCA
      // MÁS. El botón "borrar evento" de esta misma pantalla contestaba "este
      // evento ya salió del borrador" para algo creado hace diez segundos, y el
      // rollback de más abajo —el que deshace el evento cuando no se pudo
      // guardar a quiénes afecta— rebotaba igual, dejando en pantalla un
      // "bórralo a mano desde el plan" que a mano tampoco se podía.
      //
      // Se manda aunque el default de la 0061 ya sea 'DRAFT': quien lee este
      // insert tiene que poder saber en qué estado nace el evento sin ir a
      // buscar un default a una migración.
      status: "DRAFT",
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
      // cambia las porciones de todos: mejor no dejarlo a medias. Y si NI
      // SIQUIERA se pudo deshacer, se dice — un evento a medias que afecta a
      // todos es justo lo que este bloque existe para impedir (gate final §5).
      const { error: deshacerError } = await supabase
        .from("nutrition_events")
        .delete()
        .eq("id", creado.id);
      if (deshacerError) {
        return {
          ok: false,
          error:
            "No se pudo guardar a quiénes afecta el evento Y el evento quedó a medias: bórralo a mano desde el plan.",
        };
      }
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

/**
 * Gate 0→10 [A-1]: guardar el reemplazo aceptado para una persona en una
 * comida concreta. La decisión sobrevive a la recarga y la ve cualquiera de
 * la casa al confirmar — antes se perdía en un query param.
 */
export async function saveSubstitution(input: {
  assignmentId: string;
  memberId: string;
  componentId: string;
  ingredientId: string;
}): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("set_substitution_choice", {
    p_assignment_id: input.assignmentId,
    p_member_id: input.memberId,
    p_component_id: input.componentId,
    p_to_ingredient_id: input.ingredientId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/plan");
  return { ok: true, message: "Reemplazo guardado para esta comida." };
}

/** Volver al alimento de la receta. */
export async function clearSubstitution(input: {
  assignmentId: string;
  memberId: string;
  componentId: string;
}): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("clear_substitution_choice", {
    p_assignment_id: input.assignmentId,
    p_member_id: input.memberId,
    p_component_id: input.componentId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/plan");
  return { ok: true, message: "Reemplazo deshecho." };
}
