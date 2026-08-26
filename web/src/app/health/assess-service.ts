import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { assessClinical } from "@/domain/clinical/engine";
import {
  CLINICAL_ENGINE_VERSION,
  type ClinicalAssessment,
  type ClinicalRestriction,
  type ConfirmedObservation,
  type LabScheduleInput,
  type NutritionSource,
} from "@/domain/clinical/types";
import type { NutrientKey } from "@/domain/catalog/types";
import { effectiveDate } from "@/domain/nutrition/calendar";
import type { ClinicalCeiling } from "@/domain/portions/optimizer";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { numeric, parseRows, uuid } from "@/lib/supabase/rows";
import {
  loadConfirmedObservations,
  loadConfirmedRestrictions,
  loadScheduleInputs,
} from "./queries";

/**
 * Evaluación clínica de una comida, como SERVICIO (no como server action).
 *
 * Por qué existe este archivo: la evaluación vivía entera dentro de
 * `assessMeal` en `actions.ts`, que es un módulo `"use server"` — ahí todo lo
 * exportado es una server action y no se puede exportar nada más (ni un tipo,
 * ni una función que reciba el cliente de Supabase). Resultado: `confirmMeal`
 * no tenía forma de reusarla y el motor clínico quedó DESCONECTADO del único
 * camino que crea porciones de verdad. La lógica se mudó acá, `assessMeal`
 * quedó como envoltorio, y ahora el planificador la puede llamar.
 *
 * Reglas que este servicio no negocia:
 *  · UNKNOWN NUNCA SIGNIFICA NORMAL: si no se pudo evaluar, no se devuelve
 *    "compatible"; se dice que no se pudo (`persistMealAssessment` falla y
 *    quien llama tiene que dejar la porción en revisión).
 *  · ERROR != VACÍO: una lectura que rebota lanza; jamás se convierte en
 *    "esta persona no tiene restricciones".
 */

type Db = SupabaseClient;

/**
 * Contexto clínico de una persona (lo único que el motor acepta: CONFIRMADO).
 *
 * OJO con la lectura vacía: las RLS de `member_clinical_restrictions` y
 * `lab_observations` filtran por `app.medical_access`. Quien no tiene permiso
 * NO recibe un error: recibe CERO filas. Por eso "cero restricciones" jamás
 * puede tomarse por sí solo como "esta comida está limpia" — la autorización
 * se comprueba al PERSISTIR (ver `persistMealAssessment`).
 */
export interface ClinicalContext {
  memberId: string;
  restrictions: ClinicalRestriction[];
  observations: ConfirmedObservation[];
  schedules: LabScheduleInput[];
}

export async function loadClinicalContext(db: Db, memberId: string): Promise<ClinicalContext> {
  const [restrictions, observations, schedules] = await Promise.all([
    loadConfirmedRestrictions(db, memberId),
    loadConfirmedObservations(db, memberId),
    loadScheduleInputs(db, memberId),
  ]);
  return { memberId, restrictions, observations, schedules };
}

export interface MealAssessment {
  assessment: ClinicalAssessment;
  /** Día civil con el que se evaluó: vigencia de reglas y de exámenes. */
  date: string;
  /** Foto de las restricciones usadas, para congelarla junto al veredicto. */
  restrictions: readonly ClinicalRestriction[];
}

export interface EvaluateMealInput {
  memberId: string;
  versionId: string;
  /**
   * `null` = todavía no existe la porción de esta persona: se evalúa contra la
   * porción base de la receta y el veredicto es un SCREENING (§1), nunca un
   * "compatible" individual.
   */
  assignmentId: string | null;
  /** Día de la comida. Sin él se usa el día civil del hogar. */
  date?: string | null;
  /** Contexto ya cargado, para no releerlo dos veces en la misma confirmación. */
  context?: ClinicalContext | null;
}

/**
 * Corre el motor clínico y devuelve el veredicto. NO persiste nada.
 *
 * Lanza si alguna lectura rebota: un error de base jamás se degrada a
 * "sin restricciones".
 */
export async function evaluateMeal(db: Db, input: EvaluateMealInput): Promise<MealAssessment> {
  const contexto = input.context ?? (await loadClinicalContext(db, input.memberId));
  const { restrictions, observations, schedules } = contexto;

  // QA §100 lente A [A-1]: una restricción clínica es POR PORCIÓN. Comparar
  // contra `recipe_nutrition` —que es el TOTAL de la receta para
  // `base_servings` personas— invalidaba comidas seguras (en un máximo) y,
  // peor, declaraba cumplido un MÍNIMO que la porción individual no alcanza.
  //
  // Orden de preferencia, del dato más real al más estimado:
  //  1. la porción CONFIRMADA de esta persona en esta comida (la verdad);
  //  2. el total de la receta dividido por sus porciones base (estimación de
  //     porción estándar, declarada como tal en las razones).
  const valores: Record<string, number | null> = {};
  const completeness: Record<string, "COMPLETE" | "PARTIAL" | "UNKNOWN"> = {};
  let fuenteNutricion: NutritionSource = "NONE";

  const { data: versionBase, error: versionBaseError } = await db
    .from("meal_template_versions")
    .select("base_servings")
    .eq("id", input.versionId)
    .maybeSingle();
  if (versionBaseError) throw new DataAccessError("porciones base de la receta", versionBaseError);
  const porcionesBase =
    z.object({ base_servings: z.number().int().positive() }).nullable().parse(versionBase)
      ?.base_servings ?? null;

  if (input.assignmentId) {
    const { data: proy, error: proyError } = await db
      .from("member_serving_projections")
      .select("nutrition, completeness, status")
      .eq("assignment_id", input.assignmentId)
      .eq("member_id", input.memberId)
      .maybeSingle();
    if (proyError) throw new DataAccessError("porción de la comida", proyError);
    if (proy) {
      const fila = z
        .object({
          nutrition: z.record(z.string(), z.unknown()).catch({}),
          completeness: z.record(z.string(), z.string()).catch({}),
          status: z.string(),
        })
        .parse(proy);
      // El optimizador guarda la nutrición YA por porción.
      const dentro = (fila.nutrition.values ?? fila.nutrition) as Record<string, unknown>;
      for (const [k, v] of Object.entries(dentro)) {
        if (typeof v === "number") valores[k] = v;
      }
      const compDentro = (fila.nutrition.completeness ?? fila.completeness) as Record<string, unknown>;
      for (const [k, v] of Object.entries(compDentro ?? {})) {
        if (typeof v === "string") completeness[k] = v as "COMPLETE" | "PARTIAL" | "UNKNOWN";
      }
      if (Object.keys(valores).length > 0) {
        // §1: servida/comida = hecho consumado; planificada = proyección.
        fuenteNutricion =
          fila.status === "SERVED" || fila.status === "CONSUMED"
            ? "CONFIRMED_MEMBER_SERVING"
            : "PROJECTED_MEMBER_SERVING";
      }
    }
  }

  if (fuenteNutricion === "NONE") {
    const { data: nutricion, error: nutricionError } = await db
      .from("recipe_nutrition")
      .select("*")
      .eq("version_id", input.versionId)
      .maybeSingle();
    if (nutricionError) throw new DataAccessError("nutrición de la receta", nutricionError);

    if (nutricion && porcionesBase) {
      const filaNutricion = z
        .object({ completeness: z.record(z.string(), z.string()).catch({}) })
        .passthrough()
        .parse(nutricion);
      for (const [k, v] of Object.entries(filaNutricion)) {
        // El total de la receta ÷ sus porciones base = porción estándar.
        if (typeof v === "number") valores[k] = v / porcionesBase;
      }
      for (const [k, v] of Object.entries(filaNutricion.completeness)) {
        completeness[k] = v as "COMPLETE" | "PARTIAL" | "UNKNOWN";
      }
      fuenteNutricion = "RECIPE_BASE_ESTIMATE";
    }
  }

  const { data: comps, error: compsError } = await db
    .from("meal_slot_components")
    .select("ingredient_id, quantity, meal_slots!inner ( version_id ), ingredients ( category_id )")
    .eq("meal_slots.version_id", input.versionId);
  if (compsError) throw new DataAccessError("componentes de la receta", compsError);
  const compFila = z.object({
    ingredient_id: uuid.nullable(),
    quantity: numeric,
    ingredients: z
      .union([z.object({ category_id: uuid.nullable() }), z.array(z.object({ category_id: uuid.nullable() })), z.null()])
      .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
  });
  const componentes = parseRows(compFila, comps, "componentes de la receta");

  const hoy = input.date ?? (await diaDelHogar(db, input.memberId));

  const evaluacion = assessClinical({
    date: hoy,
    nutritionSource: fuenteNutricion,
    restrictions,
    observations,
    schedules,
    nutrition: { values: valores, completeness },
    ingredientIds: componentes.map((c) => c.ingredient_id).filter((x): x is string => x !== null),
    categoryIds: componentes
      .map((c) => c.ingredients?.category_id ?? null)
      .filter((x): x is string => x !== null),
    // [A-1]: las cantidades de la receta también son totales. PORTION_MAX/MIN
    // se evalúa por porción, así que se divide por las porciones base; si no
    // se conocen, NO se manda nada y el motor pide revisión en vez de adivinar.
    quantitiesByIngredient: porcionesBase
      ? Object.fromEntries(
          componentes
            .filter((c) => c.ingredient_id !== null)
            .map((c) => [c.ingredient_id!, c.quantity / porcionesBase]),
        )
      : {},
  });

  return { assessment: evaluacion, date: hoy, restrictions };
}

/** Día civil del hogar de esta persona (nunca el reloj del servidor a secas). */
async function diaDelHogar(db: Db, memberId: string): Promise<string> {
  const { data: hogar, error: hogarError } = await db
    .from("household_members")
    .select("households ( timezone )")
    .eq("id", memberId)
    .maybeSingle();
  if (hogarError) throw new DataAccessError("zona horaria", hogarError);
  const tzFila = z
    .object({
      households: z
        .union([z.object({ timezone: z.string().nullable() }), z.array(z.object({ timezone: z.string().nullable() })), z.null()])
        .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
    })
    .nullable()
    .parse(hogar);
  return effectiveDate(new Date(), tzFila?.households?.timezone ?? "America/Santiago");
}

/**
 * Guarda el veredicto con su foto de restricciones.
 *
 * El RPC exige `app.medical_access(member, 'VIEW_CLINICAL_RESTRICTIONS')`: la
 * MISMA condición que la RLS de lectura de restricciones. Por eso guardar no
 * es solo guardar — es la comprobación de que la evaluación se hizo con los
 * datos completos. Si acá sale "no autorizado", el veredicto que se acaba de
 * calcular se descarta: se calculó sobre una lectura vacía por falta de
 * permiso, y un "compatible" así sería justo la mentira que el Sprint 11
 * existe para impedir.
 */
export async function persistMealAssessment(
  db: Db,
  input: {
    memberId: string;
    versionId: string;
    assignmentId: string | null;
    evaluacion: MealAssessment;
  },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { assessment, date, restrictions } = input.evaluacion;
  const { data, error } = await db.rpc("save_meal_clinical_assessment", {
    p_member_id: input.memberId,
    p_version_id: input.versionId,
    p_assignment_id: input.assignmentId,
    p_assessed_on: date,
    p_engine_version: CLINICAL_ENGINE_VERSION,
    p_status: assessment.status,
    p_payload: {
      reasons: assessment.reasons,
      missing_data: assessment.missingData,
      rule_refs: assessment.ruleRefs,
      restriction_snapshot: restrictions.map((r) => ({ id: r.id, ruleVersionId: r.ruleVersionId })),
      // §1 del cierre v2: la fuente es columna propia (0029), no un detalle
      // enterrado. De ella depende la FUERZA del veredicto.
      nutrition_source: assessment.nutritionSource,
      observation_refs: assessment.observationRefs,
      proposed_adjustments: assessment.proposedAdjustments,
    },
  });
  if (error) return { ok: false, error: error.message };
  if (typeof data !== "string") {
    return { ok: false, error: "el guardado no devolvió el identificador de la evaluación" };
  }
  return { ok: true, id: data };
}

/**
 * Techos que el optimizador PUEDE usar, sacados del veredicto (§31).
 *
 * Dos restricciones pueden capar el mismo nutriente: se queda el MÁS BAJO, no
 * el primero que llegó. Y el orden se fija por nombre de nutriente para que la
 * misma entrada produzca siempre la misma porción (motor determinista, §47).
 */
export function clinicalCeilingsFrom(assessment: ClinicalAssessment): ClinicalCeiling[] {
  const porNutriente = new Map<NutrientKey, ClinicalCeiling>();
  for (const ajuste of assessment.proposedAdjustments) {
    if (ajuste.kind !== "NUTRIENT_CEILING") continue;
    // Un techo que no es un número no es un techo: se ignora y la comida
    // igual queda marcada por el motor, que ya subió el nivel de revisión.
    if (!Number.isFinite(ajuste.max)) continue;
    const previo = porNutriente.get(ajuste.nutrient);
    if (previo && previo.max <= ajuste.max) continue;
    porNutriente.set(ajuste.nutrient, {
      nutrient: ajuste.nutrient,
      max: ajuste.max,
      restrictionId: ajuste.restrictionId,
    });
  }
  return [...porNutriente.values()].sort((a, b) => a.nutrient.localeCompare(b.nutrient));
}
