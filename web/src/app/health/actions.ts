"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { numeric, parseRows, uuid } from "@/lib/supabase/rows";
import { extractFromText } from "@/domain/clinical/extraction";
import { assessClinical } from "@/domain/clinical/engine";
import { CLINICAL_ENGINE_VERSION } from "@/domain/clinical/types";
import { effectiveDate } from "@/domain/nutrition/calendar";
import {
  loadConfirmedObservations,
  loadConfirmedRestrictions,
  loadDocument,
  loadScheduleInputs,
} from "./queries";

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  id?: string;
}

async function client() {
  return createSupabaseServer();
}

const BUCKET = "medical-documents";
const TIPOS_PERMITIDOS = ["text/plain", "application/pdf", "image/jpeg", "image/png"];
const TAMANO_MAX = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Subida (§53) — validación de archivo (§48) + bucket privado (§47)
// ---------------------------------------------------------------------------

export async function uploadExam(formData: FormData): Promise<ActionResult> {
  const supabase = await client();
  const memberId = String(formData.get("memberId") ?? "");
  const documentDate = String(formData.get("documentDate") ?? "");
  const sourceLab = String(formData.get("sourceLab") ?? "");
  const archivo = formData.get("file");

  if (!z.string().uuid().safeParse(memberId).success) {
    return { ok: false, error: "Integrante inválido." };
  }
  if (!(archivo instanceof File) || archivo.size === 0) {
    return { ok: false, error: "Falta el archivo del examen." };
  }
  if (!TIPOS_PERMITIDOS.includes(archivo.type)) {
    return { ok: false, error: "Formato no soportado: PDF, JPG, PNG o texto." };
  }
  if (archivo.size > TAMANO_MAX) {
    return { ok: false, error: "El archivo supera los 5 MB." };
  }

  // La ruta lleva al integrante: la política del bucket exige UPLOAD_LABS
  // sobre ese member — un document_id ajeno no se puede colar (§48).
  const extension = archivo.name.split(".").pop()?.toLowerCase() ?? "bin";
  const path = `member/${memberId}/${crypto.randomUUID()}.${extension}`;
  const subida = await supabase.storage.from(BUCKET).upload(path, archivo, {
    contentType: archivo.type,
    upsert: false,
  });
  if (subida.error) {
    return { ok: false, error: `No se pudo guardar el archivo: ${subida.error.message}` };
  }

  const { data, error } = await supabase.rpc("upload_lab_document", {
    p_member_id: memberId,
    p_document_date: documentDate || null,
    p_source_lab: sourceLab,
    p_document_type: "LAB_RESULTS",
    p_storage_path: path,
  });
  if (error) {
    // El documento no se registró: el archivo huérfano se retira.
    await supabase.storage.from(BUCKET).remove([path]);
    return { ok: false, error: `No se pudo registrar el examen: ${error.message}` };
  }
  revalidatePath("/health");
  return { ok: true, id: data as string, message: "Examen subido." };
}

export async function setConsent(documentId: string, granted: boolean): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("set_lab_ai_consent", {
    p_document_id: documentId,
    p_granted: granted,
    p_purpose: granted ? "Extraer biomarcadores del examen para revisión humana" : null,
  });
  if (error) return { ok: false, error: `No se pudo guardar el consentimiento: ${error.message}` };
  revalidatePath(`/health/exams/${documentId}`);
  return {
    ok: true,
    message: granted
      ? "Consentimiento registrado: la extracción queda disponible."
      : "Sin consentimiento: el examen se revisa a mano.",
  };
}

/** URL firmada de corta vida (§47): jamás una URL pública permanente. */
export async function getExamSignedUrl(documentId: string): Promise<ActionResult & { url?: string }> {
  const supabase = await client();
  const doc = await loadDocument(supabase, documentId); // RLS decide
  if (!doc?.storage_path) return { ok: false, error: "Este examen no tiene archivo adjunto." };
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(doc.storage_path, 300);
  if (error || !data) return { ok: false, error: "No se pudo generar el enlace temporal." };
  return { ok: true, url: data.signedUrl };
}

// ---------------------------------------------------------------------------
// Extracción (§9/§54) — capa sustituible; el servidor re-verifica el consentimiento
// ---------------------------------------------------------------------------

export async function runExtraction(documentId: string): Promise<ActionResult> {
  const supabase = await client();
  const doc = await loadDocument(supabase, documentId);
  if (!doc) return { ok: false, error: "Examen no encontrado." };
  if (doc.ai_consent_status !== "GRANTED") {
    return { ok: false, error: "Sin consentimiento para extracción por IA: consiente primero o revisa a mano." };
  }
  if (!doc.storage_path) return { ok: false, error: "El examen no tiene archivo adjunto." };

  const bajada = await supabase.storage.from(BUCKET).download(doc.storage_path);
  if (bajada.error || !bajada.data) {
    return { ok: false, error: "No se pudo leer el archivo del examen." };
  }
  const mime = bajada.data.type || "application/octet-stream";
  const resultado =
    mime.startsWith("text/")
      ? extractFromText(await bajada.data.text(), mime)
      : extractFromText("", mime); // PDF/imagen: FAILED honesto (§54)

  if (!resultado.ok) {
    // El RPC deja el documento en FAILED al recibir cero candidatos.
    const { error } = await supabase.rpc("submit_lab_extraction", {
      p_document_id: documentId,
      p_processor_version: resultado.processorVersion,
      p_candidates: [],
    });
    if (error) return { ok: false, error: `La extracción falló: ${error.message}` };
    revalidatePath(`/health/exams/${documentId}`);
    return { ok: false, error: resultado.error };
  }

  const { data, error } = await supabase.rpc("submit_lab_extraction", {
    p_document_id: documentId,
    p_processor_version: resultado.processorVersion,
    p_candidates: resultado.candidates,
  });
  if (error) return { ok: false, error: `No se pudo registrar la extracción: ${error.message}` };
  revalidatePath(`/health/exams/${documentId}`);
  return { ok: true, message: `${data} fila(s) extraídas. Nada afecta decisiones hasta que confirmes.` };
}

// ---------------------------------------------------------------------------
// Revisión (§10) y corrección (§11)
// ---------------------------------------------------------------------------

export interface ReviewDecision {
  candidateId: string;
  action: "CONFIRM" | "EDIT" | "DISCARD";
  biomarkerId?: string | null;
  value?: number | null;
  unit?: string | null;
  referenceLow?: number | null;
  referenceHigh?: number | null;
  collectedDate?: string | null;
}

export async function confirmReview(
  documentId: string,
  decisions: ReviewDecision[],
): Promise<ActionResult> {
  const supabase = await client();
  const payload = decisions.map((d) => ({
    candidate_id: d.candidateId,
    action: d.action,
    ...(d.biomarkerId !== undefined ? { biomarker_id: d.biomarkerId } : {}),
    ...(d.value !== undefined ? { value: d.value } : {}),
    ...(d.unit !== undefined ? { unit: d.unit } : {}),
    ...(d.referenceLow !== undefined ? { reference_low: d.referenceLow } : {}),
    ...(d.referenceHigh !== undefined ? { reference_high: d.referenceHigh } : {}),
    ...(d.collectedDate !== undefined ? { collected_date: d.collectedDate } : {}),
  }));
  const { data, error } = await supabase.rpc("confirm_lab_extraction", {
    p_document_id: documentId,
    p_decisions: payload,
  });
  if (error) return { ok: false, error: `No se pudo confirmar: ${error.message}` };

  // §34: el examen confirmado dispara el impacto — idempotente, jamás aplica solo.
  const doc = await loadDocument(supabase, documentId);
  if (doc?.processing_status === "CONFIRMED") {
    const { error: impactoError } = await supabase.rpc("create_clinical_impact_review", {
      p_member_id: doc.member_id,
      p_trigger_kind: "LAB_RESULTS_CONFIRMED",
      p_trigger_ref: documentId,
      p_summary: { note: "nuevo examen confirmado: revisar comidas y porciones" },
    });
    if (impactoError) {
      return {
        ok: false,
        error: `Las observaciones se confirmaron pero la revisión de impacto no se pudo crear: ${impactoError.message}`,
      };
    }
  }
  const r = data as { confirmed: number; discarded: number };
  revalidatePath(`/health/exams/${documentId}`);
  revalidatePath("/health");
  return { ok: true, message: `${r.confirmed} confirmadas · ${r.discarded} descartadas.` };
}

export async function correctObservation(
  observationId: string,
  newValue: number,
  newUnit: string | null,
  reason: string,
): Promise<ActionResult> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("correct_lab_observation", {
    p_observation_id: observationId,
    p_new_value: newValue,
    p_new_unit: newUnit,
    p_reason: reason,
  });
  if (error) return { ok: false, error: `No se pudo corregir: ${error.message}` };
  revalidatePath("/health");
  return { ok: true, id: data as string, message: "Corrección registrada; la historia conserva ambas." };
}

// ---------------------------------------------------------------------------
// Grants (§41)
// ---------------------------------------------------------------------------

export async function grantAccess(
  ownerMemberId: string,
  granteeMemberId: string,
  permission: string,
): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("grant_medical_access", {
    p_owner_member: ownerMemberId,
    p_grantee_member: granteeMemberId,
    p_permission: permission,
  });
  if (error) return { ok: false, error: `No se pudo conceder: ${error.message}` };
  revalidatePath("/health");
  return { ok: true, message: "Permiso concedido." };
}

export async function revokeAccess(grantId: string): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("revoke_medical_access", { p_grant: grantId });
  if (error) return { ok: false, error: `No se pudo revocar: ${error.message}` };
  revalidatePath("/health");
  return { ok: true, message: "Permiso revocado: el acceso terminó ahora." };
}

// ---------------------------------------------------------------------------
// Restricciones (§19) y frecuencias (§15)
// ---------------------------------------------------------------------------

export async function createRestriction(input: {
  memberId: string;
  type: string;
  target: string;
  value: number | null;
  unit: string | null;
  severity: string;
  source: string;
  sourceReference: string | null;
  reason: string;
  confirm: boolean;
}): Promise<ActionResult> {
  const supabase = await client();
  const { data, error } = await supabase.rpc("create_clinical_restriction", {
    p_member_id: input.memberId,
    p_type: input.type,
    p_target: input.target,
    p_value: input.value,
    p_unit: input.unit,
    p_severity: input.severity,
    p_source: input.source,
    p_source_reference: input.sourceReference,
    p_rule_version_id: null,
    p_reason: input.reason,
    p_confirm: input.confirm,
  });
  if (error) return { ok: false, error: `No se pudo crear la restricción: ${error.message}` };
  revalidatePath("/health");
  return { ok: true, id: data as string, message: input.confirm ? "Restricción confirmada." : "Restricción creada (sin confirmar aún)." };
}

export async function setRestrictionStatus(
  restrictionId: string,
  status: "CONFIRMED" | "RETIRED",
  reason: string,
): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("set_clinical_restriction_status", {
    p_restriction_id: restrictionId,
    p_status: status,
    p_reason: reason,
  });
  if (error) return { ok: false, error: `No se pudo actualizar: ${error.message}` };
  revalidatePath("/health");
  return { ok: true, message: status === "CONFIRMED" ? "Restricción confirmada." : "Restricción retirada." };
}

export async function saveSchedule(input: {
  memberId: string;
  biomarkerId: string;
  intervalDays: number;
  source: "USER" | "DOCTOR" | "NUTRITIONIST" | "CLINICAL_PROTOCOL";
  notes: string | null;
}): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.from("member_lab_schedules").insert({
    member_id: input.memberId,
    biomarker_id: input.biomarkerId,
    expected_interval_days: input.intervalDays,
    source: input.source,
    notes: input.notes,
  });
  if (error) return { ok: false, error: `No se pudo guardar la frecuencia: ${error.message}` };
  revalidatePath("/health");
  return { ok: true, message: "Frecuencia guardada (definida por su fuente, no por la app)." };
}

// ---------------------------------------------------------------------------
// Evaluación clínica de una comida (§30) — motor puro + persistencia con snapshot
// ---------------------------------------------------------------------------

export async function assessMeal(input: {
  memberId: string;
  versionId: string;
  assignmentId: string | null;
}): Promise<ActionResult & { status?: string }> {
  const supabase = await client();

  const [restricciones, observaciones, frecuencias] = await Promise.all([
    loadConfirmedRestrictions(supabase, input.memberId),
    loadConfirmedObservations(supabase, input.memberId),
    loadScheduleInputs(supabase, input.memberId),
  ]);

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
  let fuenteNutricion: "SERVING" | "RECIPE_PER_SERVING" | "NONE" = "NONE";

  const { data: versionBase, error: versionBaseError } = await supabase
    .from("meal_template_versions")
    .select("base_servings")
    .eq("id", input.versionId)
    .maybeSingle();
  if (versionBaseError) throw new DataAccessError("porciones base de la receta", versionBaseError);
  const porcionesBase =
    z.object({ base_servings: z.number().int().positive() }).nullable().parse(versionBase)
      ?.base_servings ?? null;

  if (input.assignmentId) {
    const { data: proy, error: proyError } = await supabase
      .from("member_serving_projections")
      .select("nutrition, completeness")
      .eq("assignment_id", input.assignmentId)
      .eq("member_id", input.memberId)
      .maybeSingle();
    if (proyError) throw new DataAccessError("porción de la comida", proyError);
    if (proy) {
      const fila = z
        .object({
          nutrition: z.record(z.string(), z.unknown()).catch({}),
          completeness: z.record(z.string(), z.string()).catch({}),
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
      if (Object.keys(valores).length > 0) fuenteNutricion = "SERVING";
    }
  }

  if (fuenteNutricion === "NONE") {
    const { data: nutricion, error: nutricionError } = await supabase
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
      fuenteNutricion = "RECIPE_PER_SERVING";
    }
  }

  const { data: comps, error: compsError } = await supabase
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

  const { data: hogar, error: hogarError } = await supabase
    .from("household_members")
    .select("households ( timezone )")
    .eq("id", input.memberId)
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
  const hoy = effectiveDate(new Date(), tzFila?.households?.timezone ?? "America/Santiago");

  const evaluacion = assessClinical({
    date: hoy,
    restrictions: restricciones,
    observations: observaciones,
    schedules: frecuencias,
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

  const { data: guardada, error: guardadaError } = await supabase.rpc("save_meal_clinical_assessment", {
    p_member_id: input.memberId,
    p_version_id: input.versionId,
    p_assignment_id: input.assignmentId,
    p_assessed_on: hoy,
    p_engine_version: CLINICAL_ENGINE_VERSION,
    p_status: evaluacion.status,
    p_payload: {
      reasons: evaluacion.reasons,
      missing_data: evaluacion.missingData,
      rule_refs: evaluacion.ruleRefs,
      restriction_snapshot: restricciones.map((r) => ({ id: r.id, ruleVersionId: r.ruleVersionId })),
      // §96: de dónde salió la nutrición evaluada — la porción real o una
      // estimación de porción estándar. Quien lea la evaluación lo sabe.
      nutrition_source: fuenteNutricion,
      observation_refs: evaluacion.observationRefs,
      proposed_adjustments: evaluacion.proposedAdjustments,
    },
  });
  if (guardadaError) {
    return { ok: false, error: `La evaluación no se pudo guardar: ${guardadaError.message}` };
  }
  return { ok: true, id: guardada as string, status: evaluacion.status };
}

// ---------------------------------------------------------------------------
// Impact reviews (§35/§36)
// ---------------------------------------------------------------------------

export async function resolveImpact(
  reviewId: string,
  resolution: "REVIEWED" | "APPLIED" | "DISMISSED",
  servingStatus: { projectionId: string; status: string; assessmentId: string | null }[] = [],
): Promise<ActionResult> {
  const supabase = await client();
  const { error } = await supabase.rpc("resolve_clinical_impact_review", {
    p_review_id: reviewId,
    p_resolution: resolution,
    p_serving_status: servingStatus.map((s) => ({
      projection_id: s.projectionId,
      status: s.status,
      assessment_id: s.assessmentId,
    })),
  });
  if (error) return { ok: false, error: `No se pudo resolver la revisión: ${error.message}` };
  revalidatePath("/health");
  revalidatePath("/plan");
  return { ok: true, message: "Revisión resuelta." };
}
