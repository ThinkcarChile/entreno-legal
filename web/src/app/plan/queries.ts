import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { dateString, nullableNumeric, parseRows, uuid } from "@/lib/supabase/rows";
import { weekDays } from "@/domain/nutrition/calendar";
import type { DayEvent, EventStrategy } from "@/domain/nutrition/events";
import type { MealType } from "@/domain/recipes/types";

type Db = SupabaseClient;

/**
 * Lectura de la semana. Igual que el resto de la capa de datos: se valida, no se
 * castea, y un error jamás se convierte en "no hay nada planificado".
 */

export type AssignmentKind = "RECIPE" | "EAT_OUT" | "LEFTOVER" | "EVENT" | "FREE";
export type AssignmentStatus = "PLANNED" | "CONFIRMED" | "SERVED" | "SKIPPED";

export interface Assignment {
  id: string;
  mealType: MealType;
  kind: AssignmentKind;
  status: AssignmentStatus;
  templateId: string | null;
  versionId: string | null;
  recipeName: string | null;
  versionNumber: number | null;
  notes: string | null;
  /** Sprint 11 §58: porciones con estado clínico que exige revisión (solo el conteo). */
  clinicalReviewCount: number;
  /** Cuántas porciones quedaron guardadas al confirmar. */
  servingCount: number;
  /**
   * Quiénes comen. VACÍO = comen todos los integrantes activos, que es el caso
   * normal: se guardan filas solo cuando alguien queda fuera.
   */
  participantIds: string[];
  /** Algo cambió alrededor de esta comida ya confirmada (§18). */
  needsReview: boolean;
  reviewReason: string | null;
  /** Cuántas veces se confirmó, para poder ver que hubo recálculos (§12). */
  confirmCount: number;
}

export interface PlanDay {
  id: string;
  date: string;
  assignments: Assignment[];
}

export interface WeekPlan {
  planId: string;
  householdId: string;
  weekStart: string;
  status: string;
  days: PlanDay[];
  events: {
    id: string;
    date: string;
    endDate: string | null;
    eventType: string;
    mealType: MealType | null;
    strategy: string;
    title: string;
    /** Integrantes afectados. VACÍO = toda la familia. */
    memberIds: string[];
  }[];
}

const assignmentRowSchema = z.object({
  id: uuid,
  day_id: uuid,
  meal_type: z.string(),
  kind: z.enum(["RECIPE", "EAT_OUT", "LEFTOVER", "EVENT", "FREE"]),
  status: z.enum(["PLANNED", "CONFIRMED", "SERVED", "SKIPPED"]),
  template_id: uuid.nullable(),
  version_id: uuid.nullable(),
  notes: z.string().nullable(),
  needs_review: z.boolean(),
  review_reason: z.string().nullable(),
  confirm_count: z.number().int(),
});

const dayRowSchema = z.object({ id: uuid, plan_date: dateString });

const versionRowSchema = z.object({
  id: uuid,
  version_number: z.number().int(),
  name: z.string(),
});

const eventRowSchema = z.object({
  id: uuid,
  event_date: dateString,
  end_date: dateString.nullable(),
  event_type: z.string(),
  meal_type: z.string().nullable(),
  strategy: z.string(),
  title: z.string(),
});

/** Crea la semana si no existe y devuelve su contenido completo. */
export async function loadWeek(
  db: Db,
  householdId: string,
  weekStartDate: string,
): Promise<WeekPlan> {
  const { data: planId, error: planError } = await db.rpc("ensure_weekly_plan", {
    p_household_id: householdId,
    p_week_start: weekStartDate,
  });
  if (planError) throw new DataAccessError("semana del hogar", planError);

  const { data: plan, error: cabeceraError } = await db
    .from("weekly_plans")
    .select("id, status")
    .eq("id", planId)
    .maybeSingle();
  if (cabeceraError) throw new DataAccessError("cabecera de la semana", cabeceraError);

  const { data: dayRows, error: diasError } = await db
    .from("weekly_plan_days")
    .select("id, plan_date")
    .eq("plan_id", planId)
    .order("plan_date");
  if (diasError) throw new DataAccessError("días de la semana", diasError);
  const days = parseRows(dayRowSchema, dayRows, "días de la semana");

  const { data: assignmentRows, error: asigError } = await db
    .from("meal_assignments")
    .select(
      "id, day_id, meal_type, kind, status, template_id, version_id, notes, " +
        "needs_review, review_reason, confirm_count",
    )
    .in("day_id", days.map((d) => d.id));
  if (asigError) throw new DataAccessError("comidas planificadas", asigError);
  const assignments = parseRows(assignmentRowSchema, assignmentRows, "comidas planificadas");

  // Participantes explícitos. Sin filas para una comida = comen todos.
  const participantes = new Map<string, string[]>();
  if (assignments.length > 0) {
    const { data, error } = await db
      .from("meal_assignment_participants")
      .select("assignment_id, member_id")
      .in("assignment_id", assignments.map((a) => a.id));
    if (error) throw new DataAccessError("participantes de las comidas", error);
    const filas = parseRows(
      z.object({ assignment_id: uuid, member_id: uuid }),
      data,
      "participantes de las comidas",
    );
    for (const fila of filas) {
      const lista = participantes.get(fila.assignment_id) ?? [];
      lista.push(fila.member_id);
      participantes.set(fila.assignment_id, lista);
    }
  }

  // Nombres de receta por versión, en una sola consulta.
  const versionIds = [...new Set(assignments.map((a) => a.version_id).filter(Boolean))] as string[];
  const versiones = new Map<string, { name: string; versionNumber: number }>();
  if (versionIds.length > 0) {
    const { data, error } = await db
      .from("meal_template_versions")
      .select("id, version_number, name")
      .in("id", versionIds);
    if (error) throw new DataAccessError("versiones de receta planificadas", error);
    for (const v of parseRows(versionRowSchema, data, "versiones de receta planificadas")) {
      versiones.set(v.id, { name: v.name, versionNumber: v.version_number });
    }
  }

  // Cuántas porciones quedaron guardadas en cada comida confirmada.
  const conteos = new Map<string, number>();
  // Sprint 11 §58: el planner ve CUÁNTAS porciones requieren revisión clínica
  // — jamás por qué. El estado categórico es toda la divulgación.
  const revisionClinica = new Map<string, number>();
  const confirmadas = assignments.filter((a) => a.status !== "PLANNED").map((a) => a.id);
  if (confirmadas.length > 0) {
    const { data, error } = await db
      .from("member_serving_projections")
      .select("assignment_id, clinical_status")
      .in("assignment_id", confirmadas);
    if (error) throw new DataAccessError("porciones confirmadas", error);
    for (const fila of parseRows(
      z.object({ assignment_id: uuid, clinical_status: z.string().nullable() }),
      data,
      "porciones confirmadas",
    )) {
      conteos.set(fila.assignment_id, (conteos.get(fila.assignment_id) ?? 0) + 1);
      if (fila.clinical_status === "CLINICALLY_INVALIDATED" || fila.clinical_status === "REVIEW_REQUIRED") {
        revisionClinica.set(fila.assignment_id, (revisionClinica.get(fila.assignment_id) ?? 0) + 1);
      }
    }
  }

  const fechas = weekDays(weekStartDate);
  const { data: eventRows, error: eventosError } = await db
    .from("nutrition_events")
    .select("id, event_date, end_date, event_type, meal_type, strategy, title")
    .eq("household_id", householdId)
    .gte("event_date", fechas[0]!)
    .lte("event_date", fechas[6]!)
    .order("event_date");
  if (eventosError) throw new DataAccessError("eventos de la semana", eventosError);
  const eventos = parseRows(eventRowSchema, eventRows, "eventos de la semana");

  // A quién afecta cada evento. Sin filas = a toda la familia.
  const afectados = new Map<string, string[]>();
  if (eventos.length > 0) {
    const { data, error } = await db
      .from("nutrition_event_members")
      .select("event_id, member_id")
      .in("event_id", eventos.map((e) => e.id));
    if (error) throw new DataAccessError("integrantes de los eventos", error);
    for (const fila of parseRows(
      z.object({ event_id: uuid, member_id: uuid }),
      data,
      "integrantes de los eventos",
    )) {
      const lista = afectados.get(fila.event_id) ?? [];
      lista.push(fila.member_id);
      afectados.set(fila.event_id, lista);
    }
  }

  return {
    planId: planId as string,
    householdId,
    weekStart: weekStartDate,
    status: plan?.status ?? "DRAFT",
    days: days.map((d) => ({
      id: d.id,
      date: d.plan_date,
      assignments: assignments
        .filter((a) => a.day_id === d.id)
        .map((a) => ({
          id: a.id,
          mealType: a.meal_type as MealType,
          kind: a.kind,
          status: a.status,
          templateId: a.template_id,
          versionId: a.version_id,
          recipeName: a.version_id ? (versiones.get(a.version_id)?.name ?? null) : null,
          versionNumber: a.version_id ? (versiones.get(a.version_id)?.versionNumber ?? null) : null,
          notes: a.notes,
          servingCount: conteos.get(a.id) ?? 0,
          clinicalReviewCount: revisionClinica.get(a.id) ?? 0,
          participantIds: participantes.get(a.id) ?? [],
          needsReview: a.needs_review,
          reviewReason: a.review_reason,
          confirmCount: a.confirm_count,
        })),
    })),
    events: eventos.map((e) => ({
      id: e.id,
      date: e.event_date,
      endDate: e.end_date,
      eventType: e.event_type,
      mealType: e.meal_type as MealType | null,
      strategy: e.strategy,
      title: e.title,
      memberIds: afectados.get(e.id) ?? [],
    })),
  };
}

/** Recetas publicadas que se pueden planificar, con su versión vigente. */
export async function loadPlannableRecipes(
  db: Db,
): Promise<{ templateId: string; versionId: string; name: string; mealTypes: MealType[] }[]> {
  const { data, error } = await db
    .from("meal_templates")
    .select(
      `id, name, current_version_id,
       meal_template_versions!meal_template_versions_template_id_fkey ( id, meal_types, status )`,
    )
    .eq("is_active", true)
    .not("current_version_id", "is", null)
    .order("name");
  if (error) throw new DataAccessError("recetas planificables", error);

  const versionEmbebida = z.object({
    id: uuid,
    meal_types: z.array(z.string()).nullable(),
    status: z.string(),
  });
  const rowSchema = z.object({
    id: uuid,
    name: z.string(),
    current_version_id: uuid.nullable(),
    meal_template_versions: z
      .union([z.array(versionEmbebida), versionEmbebida, z.null()])
      .transform((v) => (v === null ? [] : Array.isArray(v) ? v : [v])),
  });

  return parseRows(rowSchema, data, "recetas planificables")
    .filter((r) => r.current_version_id)
    .map((r) => {
      const vigente = r.meal_template_versions.find((v) => v.id === r.current_version_id);
      return {
        templateId: r.id,
        versionId: r.current_version_id!,
        name: r.name,
        mealTypes: (vigente?.meal_types ?? []) as MealType[],
      };
    });
}

/** Porciones guardadas de una comida confirmada, con sus reemplazos. */
export async function loadConfirmedServings(db: Db, assignmentId: string) {
  const { data, error } = await db
    .from("member_serving_projections")
    .select(
      `id, member_id, fit, adaptation_level, nutrition, completeness, reasons, status,
       unverifiable_constraints, clinical_status,
       meal_clinical_assessments!clinical_assessment_id ( nutrition_source, status ),
       optimizer_version, version_id, profile_id,
       household_members ( display_name ),
       member_serving_components (
         label, base_quantity, proposed_quantity, unit, cooking_method, added_fat_g, sort_order
       ),
       member_serving_substitutions ( to_ingredient_id, from_ingredient_id, reason_code )`,
    )
    .eq("assignment_id", assignmentId);
  if (error) throw new DataAccessError("porciones guardadas", error);

  const miembro = z.object({ display_name: z.string() });
  const componente = z.object({
    label: z.string(),
    base_quantity: nullableNumeric,
    proposed_quantity: nullableNumeric,
    unit: z.string(),
    cooking_method: z.string().nullable(),
    added_fat_g: nullableNumeric,
    sort_order: z.number().int(),
  });
  const sustitucion = z.object({
    to_ingredient_id: uuid,
    from_ingredient_id: uuid.nullable(),
    reason_code: z.string(),
  });

  const rowSchema = z.object({
    id: uuid,
    member_id: uuid,
    fit: z.string(),
    adaptation_level: z.number().int(),
    nutrition: z.record(z.unknown()),
    completeness: z.record(z.unknown()),
    reasons: z.array(z.unknown()),
    unverifiable_constraints: z.array(z.string()).catch([]),
    clinical_status: z.string().nullable().catch(null),
    meal_clinical_assessments: z
      .union([
        z.object({ nutrition_source: z.string(), status: z.string() }),
        z.array(z.object({ nutrition_source: z.string(), status: z.string() })),
        z.null(),
      ])
      .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v))
      .catch(null),
    status: z.string(),
    optimizer_version: z.string(),
    version_id: uuid,
    profile_id: uuid,
    household_members: z
      .union([miembro, z.array(miembro), z.null()])
      .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
    member_serving_components: z
      .union([z.array(componente), componente, z.null()])
      .transform((v) => (v === null ? [] : Array.isArray(v) ? v : [v])),
    member_serving_substitutions: z
      .union([z.array(sustitucion), sustitucion, z.null()])
      .transform((v) => (v === null ? [] : Array.isArray(v) ? v : [v])),
  });

  return parseRows(rowSchema, data, "porciones guardadas").map((row) => ({
    id: row.id,
    memberId: row.member_id,
    memberName: row.household_members?.display_name ?? "Integrante",
    fit: row.fit,
    adaptationLevel: row.adaptation_level,
    status: row.status,
    optimizerVersion: row.optimizer_version,
    versionId: row.version_id,
    profileId: row.profile_id,
    nutrition: row.nutrition,
    completeness: row.completeness,
    reasons: row.reasons as { code: string; text: string }[],
    unverifiableConstraints: row.unverifiable_constraints,
    // §43: SOLO el estado categórico — la cocina jamás ve el porqué clínico.
    clinicalStatus: row.clinical_status,
    // §1: con qué se evaluó. No es dato médico: es la CALIDAD del veredicto.
    clinicalSource: row.meal_clinical_assessments?.nutrition_source ?? null,
    components: [...row.member_serving_components].sort((a, b) => a.sort_order - b.sort_order),
    substitutions: row.member_serving_substitutions,
  }));
}

/**
 * Eventos que cubren una fecha, con a quién afectan. Incluye los de varios días
 * cuyo rango contiene esa fecha — un viaje que empezó el jueves sigue vigente el
 * sábado.
 */
/**
 * Eventos vigentes ese día EN ESE HOGAR.
 *
 * Gate 0→10 [F-1/H-1]: antes filtraba solo por fecha y se apoyaba en RLS. Pero
 * RLS deja pasar todos los hogares del usuario, y quien pertenece a dos casas
 * (hijos entre dos hogares, alguien que cuida a sus padres) veía cómo el
 * "cumpleaños" de la otra casa cambiaba —y congelaba— las porciones de esta.
 * El hogar lo manda quien llama, sacado de la comida misma.
 */
export async function loadEventsForDate(
  db: Db,
  date: string,
  householdId: string,
): Promise<DayEvent[]> {
  const { data, error } = await db
    .from("nutrition_events")
    .select("id, event_date, end_date, event_type, meal_type, strategy, title")
    .eq("household_id", householdId)
    .lte("event_date", date)
    .or(`end_date.is.null,end_date.gte.${date}`);
  if (error) throw new DataAccessError("eventos del día", error);

  const eventos = parseRows(eventRowSchema, data, "eventos del día").filter(
    (e) => (e.end_date === null ? e.event_date === date : date <= e.end_date),
  );
  if (eventos.length === 0) return [];

  const { data: filas, error: miembrosError } = await db
    .from("nutrition_event_members")
    .select("event_id, member_id")
    .in("event_id", eventos.map((e) => e.id));
  if (miembrosError) throw new DataAccessError("integrantes de los eventos", miembrosError);

  const afectados = new Map<string, string[]>();
  for (const fila of parseRows(
    z.object({ event_id: uuid, member_id: uuid }),
    filas,
    "integrantes de los eventos",
  )) {
    const lista = afectados.get(fila.event_id) ?? [];
    lista.push(fila.member_id);
    afectados.set(fila.event_id, lista);
  }

  return eventos.map((e) => ({
    id: e.id,
    date: e.event_date,
    endDate: e.end_date,
    eventType: e.event_type,
    mealType: e.meal_type as MealType | null,
    strategy: e.strategy as EventStrategy,
    title: e.title,
    memberIds: afectados.get(e.id) ?? [],
  }));
}
