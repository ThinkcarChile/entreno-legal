"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { extractFromText } from "@/domain/clinical/extraction";
import { evaluateMeal, persistMealAssessment } from "./assess-service";
import { loadDocument } from "./queries";

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
    // El documento no se registró: el archivo huérfano se retira. El resultado
    // del remove() NO se puede descartar — si el borrado falla queda un PDF
    // médico en el bucket sin ninguna fila que lo referencie, y nadie se entera.
    // ERROR != VACÍO: se deja rastro en el log del servidor con la ruta exacta
    // para poder limpiarlo después, y se le dice la verdad a la persona.
    const retiro = await supabase.storage.from(BUCKET).remove([path]);
    const quedoHuerfano = Boolean(retiro.error) || (retiro.data ?? []).length === 0;
    if (quedoHuerfano) {
      console.error("[health.uploadExam] archivo huérfano en el bucket médico", {
        bucket: BUCKET,
        path,
        memberId,
        errorRegistro: error.message,
        errorBorrado: retiro.error?.message ?? "el borrado no retiró ningún objeto",
      });
      return {
        ok: false,
        error:
          `No se pudo registrar el examen (${error.message}) y tampoco se pudo ` +
          "retirar el archivo que ya se había subido. Quedó guardado sin quedar " +
          "asociado a nadie: avísale a quien administra el hogar para que lo saque. " +
          "No vuelvas a subirlo hasta entonces.",
      };
    }
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

/**
 * Declara una condición de salud (diabetes, hipertensión, celiaquía…).
 *
 * Escribe por PostgREST directo porque la política `member_conditions_write`
 * (0027) ES el control: exige MANAGE_CLINICAL_RESTRICTIONS por acceso médico, y
 * este action no la relaja. `declared_by` se resuelve acá y no viene del
 * cliente: quién declaró es un hecho del servidor, no un campo de formulario.
 *
 * Lo que esta función NO hace, y es la regla de la tabla: declarar una
 * condición no crea ninguna restricción ni ningún límite. Eso pasa por
 * `createRestriction`, con fuente y confirmación. Una condición es contexto.
 */
export async function declareCondition(input: {
  memberId: string;
  label: string;
  confirmedBy: string | null;
  notes: string | null;
}): Promise<ActionResult> {
  const etiqueta = input.label.trim();
  if (etiqueta.length < 3) {
    return { ok: false, error: "Escribe el nombre de la condición (al menos 3 letras)." };
  }

  const supabase = await client();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Tu sesión expiró: vuelve a entrar." };

  // El integrante objetivo dice de qué hogar es; el declarante es la ficha del
  // usuario actual EN ESE hogar. Si no tiene ficha ahí, la RLS del insert lo
  // iba a rebotar igual — resolverlo antes da un mensaje que se entiende.
  const { data: objetivo, error: errObjetivo } = await supabase
    .from("household_members")
    .select("household_id")
    .eq("id", input.memberId)
    .maybeSingle();
  if (errObjetivo || !objetivo) return { ok: false, error: "No se encontró a esa persona." };

  const { data: declarante, error: errDeclarante } = await supabase
    .from("household_members")
    .select("id")
    .eq("household_id", objetivo.household_id)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (errDeclarante || !declarante) {
    return { ok: false, error: "No perteneces al hogar de esta persona." };
  }

  const { error } = await supabase.from("member_conditions").insert({
    member_id: input.memberId,
    label: etiqueta,
    confirmed_by: input.confirmedBy?.trim() || null,
    notes: input.notes?.trim() || null,
    declared_by: declarante.id,
  });
  if (error) return { ok: false, error: `No se pudo declarar: ${error.message}` };
  revalidatePath(`/health/member/${input.memberId}`);
  return { ok: true, message: "Condición declarada." };
}

/**
 * Quita una condición declarada.
 *
 * Acá el borrado físico es legítimo, y vale la pena decir por qué cuando todo
 * el módulo clínico es historia inmutable: una condición es una DECLARACIÓN de
 * contexto, no un hecho clínico con efectos — los efectos viven en las
 * restricciones, que sí se retiran con estado y razón, nunca se borran. El
 * esquema de la 0027 (congelado) no tiene columna de retiro, y agregar una
 * migración para conservar "declaré celiaquía por error" sería guardar basura
 * con ceremonia.
 */
export async function removeCondition(conditionId: string, memberId: string): Promise<ActionResult> {
  const supabase = await client();
  const { error, count } = await supabase
    .from("member_conditions")
    .delete({ count: "exact" })
    .eq("id", conditionId);
  if (error) return { ok: false, error: `No se pudo quitar: ${error.message}` };
  // ERROR != VACÍO: un delete que la RLS filtró borra cero filas y "funciona".
  // Decirle a la persona que se quitó algo que sigue ahí es peor que el error.
  if (!count) return { ok: false, error: "No se quitó: no tienes permiso sobre esta ficha." };
  revalidatePath(`/health/member/${memberId}`);
  return { ok: true, message: "Condición quitada." };
}

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

/**
 * Evalúa una comida para una persona y GUARDA el veredicto.
 *
 * El cuerpo vive en `assess-service.ts` porque este archivo es `"use server"`
 * y ahí todo lo exportado es una server action: `confirmMeal` no podía reusar
 * nada de acá, y por eso el motor clínico quedó construido pero desconectado
 * del único camino que crea porciones de verdad.
 */
export async function assessMeal(input: {
  memberId: string;
  versionId: string;
  assignmentId: string | null;
  /** Día de la comida. Sin él se usa el día civil del hogar. */
  date?: string | null;
}): Promise<ActionResult & { status?: string }> {
  const supabase = await client();

  const evaluacion = await evaluateMeal(supabase, {
    memberId: input.memberId,
    versionId: input.versionId,
    assignmentId: input.assignmentId,
    date: input.date ?? null,
  });

  const guardada = await persistMealAssessment(supabase, {
    memberId: input.memberId,
    versionId: input.versionId,
    assignmentId: input.assignmentId,
    evaluacion,
  });
  if (!guardada.ok) {
    return { ok: false, error: `La evaluación no se pudo guardar: ${guardada.error}` };
  }
  return { ok: true, id: guardada.id, status: evaluacion.assessment.status };
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
