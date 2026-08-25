import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { dateString, nullableNumeric, numeric, parseRows, uuid } from "@/lib/supabase/rows";
import type {
  ClinicalRestriction,
  ConfirmedObservation,
  LabScheduleInput,
} from "@/domain/clinical/types";

type Db = SupabaseClient;

/**
 * Cargadores del módulo Salud. Regla de la casa (§90): fila de Supabase →
 * Zod → mapper → dominio; cero `as` sobre filas. RLS decide QUÉ filas llegan
 * (self / grant / tutor): estos loaders jamás relajan eso.
 */

// ---------------------------------------------------------------------------
// Schemas fila
// ---------------------------------------------------------------------------

const documentRow = z.object({
  id: uuid,
  member_id: uuid,
  document_date: dateString.nullable(),
  uploaded_at: z.string(),
  source_lab_name: z.string().nullable(),
  document_type: z.string(),
  storage_path: z.string().nullable(),
  processing_status: z.string(),
  ai_consent_status: z.string(),
  extraction_version: z.string().nullable(),
  confirmed_at: z.string().nullable(),
});

const candidateRow = z.object({
  id: uuid,
  biomarker_id: uuid.nullable(),
  raw_label: z.string().nullable(),
  value: nullableNumeric,
  unit: z.string().nullable(),
  reference_low: nullableNumeric,
  reference_high: nullableNumeric,
  reference_text: z.string().nullable(),
  collected_date: dateString.nullable(),
  extraction_confidence: nullableNumeric,
  original_snippet: z.string().nullable(),
  status: z.string(),
});

const observationRow = z.object({
  id: uuid,
  member_id: uuid,
  document_id: uuid.nullable(),
  biomarker_id: uuid,
  value: numeric,
  unit: z.string().nullable(),
  reference_low: nullableNumeric,
  reference_high: nullableNumeric,
  reference_text: z.string().nullable(),
  collected_date: dateString.nullable(),
  verification_status: z.string(),
  corrected_from: uuid.nullable(),
  correction_reason: z.string().nullable(),
  notes: z.string().nullable(),
});

const biomarkerRow = z.object({
  id: uuid,
  code: z.string(),
  display_name: z.string(),
  category: z.string().nullable(),
  canonical_unit: z.string().nullable(),
});

const restrictionRow = z.object({
  id: uuid,
  member_id: uuid,
  type: z.string(),
  target: z.string(),
  value: nullableNumeric,
  unit: z.string().nullable(),
  severity: z.string(),
  source: z.string(),
  source_reference: z.string().nullable(),
  rule_version_id: uuid.nullable(),
  valid_from: dateString,
  valid_until: dateString.nullable(),
  verification_status: z.string(),
  reason: z.string().nullable(),
  confirmed_at: z.string().nullable(),
});

const scheduleRow = z.object({
  id: uuid,
  member_id: uuid,
  biomarker_id: uuid.nullable(),
  panel_label: z.string().nullable(),
  expected_interval_days: z.number().int().nullable(),
  next_due_date: dateString.nullable(),
  source: z.string(),
  enabled: z.boolean(),
});

const grantRow = z.object({
  id: uuid,
  owner_member_id: uuid,
  grantee_member_id: uuid,
  permission: z.string(),
  granted_at: z.string(),
  revoked_at: z.string().nullable(),
});

const impactRow = z.object({
  id: uuid,
  member_id: uuid,
  trigger_kind: z.string(),
  trigger_ref: uuid.nullable(),
  status: z.string(),
  summary: z.record(z.string(), z.unknown()).catch({}),
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// Cargadores
// ---------------------------------------------------------------------------

export async function loadBiomarkers(db: Db) {
  const { data, error } = await db
    .from("biomarker_definitions")
    .select("id, code, display_name, category, canonical_unit")
    .order("display_name");
  if (error) throw new DataAccessError("catálogo de biomarcadores", error);
  return parseRows(biomarkerRow, data, "catálogo de biomarcadores");
}

/** Documentos que RLS me deja ver (self / grant / tutor). */
export async function loadDocuments(db: Db, memberId?: string) {
  let q = db
    .from("lab_documents")
    .select(
      "id, member_id, document_date, uploaded_at, source_lab_name, document_type, storage_path, processing_status, ai_consent_status, extraction_version, confirmed_at",
    )
    .order("uploaded_at", { ascending: false });
  if (memberId) q = q.eq("member_id", memberId);
  const { data, error } = await q;
  if (error) throw new DataAccessError("exámenes", error);
  return parseRows(documentRow, data, "exámenes");
}

export async function loadDocument(db: Db, documentId: string) {
  const { data, error } = await db
    .from("lab_documents")
    .select(
      "id, member_id, document_date, uploaded_at, source_lab_name, document_type, storage_path, processing_status, ai_consent_status, extraction_version, confirmed_at",
    )
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new DataAccessError("examen", error);
  return data ? documentRow.parse(data) : null;
}

export async function loadCandidates(db: Db, documentId: string) {
  const { data, error } = await db
    .from("lab_extraction_candidates")
    .select(
      "id, biomarker_id, raw_label, value, unit, reference_low, reference_high, reference_text, collected_date, extraction_confidence, original_snippet, status",
    )
    .eq("document_id", documentId)
    .order("created_at");
  if (error) throw new DataAccessError("filas extraídas", error);
  return parseRows(candidateRow, data, "filas extraídas");
}

export async function loadObservations(db: Db, memberId: string) {
  const { data, error } = await db
    .from("lab_observations")
    .select(
      "id, member_id, document_id, biomarker_id, value, unit, reference_low, reference_high, reference_text, collected_date, verification_status, corrected_from, correction_reason, notes",
    )
    .eq("member_id", memberId)
    .order("collected_date", { ascending: false });
  if (error) throw new DataAccessError("observaciones", error);
  return parseRows(observationRow, data, "observaciones");
}

export async function loadRestrictions(db: Db, memberId: string) {
  const { data, error } = await db
    .from("member_clinical_restrictions")
    .select(
      "id, member_id, type, target, value, unit, severity, source, source_reference, rule_version_id, valid_from, valid_until, verification_status, reason, confirmed_at",
    )
    .eq("member_id", memberId)
    .order("created_at", { ascending: false });
  if (error) throw new DataAccessError("restricciones clínicas", error);
  return parseRows(restrictionRow, data, "restricciones clínicas");
}

export async function loadSchedules(db: Db, memberId: string) {
  const { data, error } = await db
    .from("member_lab_schedules")
    .select("id, member_id, biomarker_id, panel_label, expected_interval_days, next_due_date, source, enabled")
    .eq("member_id", memberId)
    .eq("enabled", true);
  if (error) throw new DataAccessError("frecuencias de examen", error);
  return parseRows(scheduleRow, data, "frecuencias de examen");
}

export async function loadGrants(db: Db, ownerMemberId: string) {
  const { data, error } = await db
    .from("medical_data_grants")
    .select("id, owner_member_id, grantee_member_id, permission, granted_at, revoked_at")
    .eq("owner_member_id", ownerMemberId)
    .is("revoked_at", null);
  if (error) throw new DataAccessError("permisos médicos", error);
  return parseRows(grantRow, data, "permisos médicos");
}

export async function loadImpactReviews(db: Db, memberId?: string) {
  let q = db
    .from("clinical_impact_reviews")
    .select("id, member_id, trigger_kind, trigger_ref, status, summary, created_at")
    .eq("status", "PENDING")
    .order("created_at", { ascending: false });
  if (memberId) q = q.eq("member_id", memberId);
  const { data, error } = await q;
  if (error) throw new DataAccessError("revisiones de impacto", error);
  return parseRows(impactRow, data, "revisiones de impacto");
}

// ---------------------------------------------------------------------------
// Insumos CONFIRMADOS para el motor (la única puerta al ClinicalRulesEngine)
// ---------------------------------------------------------------------------

/**
 * Observaciones CONFIRMADAS con su código de biomarcador — lo único que el
 * motor acepta. El filtro de estado va EN LA CONSULTA, no en la memoria.
 */
export async function loadConfirmedObservations(
  db: Db,
  memberId: string,
): Promise<ConfirmedObservation[]> {
  const { data, error } = await db
    .from("lab_observations")
    .select("id, value, unit, collected_date, biomarker_definitions ( code )")
    .eq("member_id", memberId)
    .eq("verification_status", "CONFIRMED");
  if (error) throw new DataAccessError("observaciones confirmadas", error);

  const fila = z.object({
    id: uuid,
    value: numeric,
    unit: z.string().nullable(),
    collected_date: dateString.nullable(),
    biomarker_definitions: z
      .union([z.object({ code: z.string() }), z.array(z.object({ code: z.string() })), z.null()])
      .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
  });
  return parseRows(fila, data, "observaciones confirmadas")
    .filter((f) => f.biomarker_definitions !== null)
    .map((f) => ({
      id: f.id,
      biomarkerCode: f.biomarker_definitions!.code,
      value: f.value,
      unit: f.unit,
      collectedDate: f.collected_date,
    }));
}

/** Restricciones CONFIRMADAS y vigentes, en la forma que el motor exige. */
export async function loadConfirmedRestrictions(
  db: Db,
  memberId: string,
): Promise<ClinicalRestriction[]> {
  const { data, error } = await db
    .from("member_clinical_restrictions")
    .select(
      "id, type, target, value, unit, severity, source, rule_version_id, valid_from, valid_until, clinical_rule_versions ( required_inputs )",
    )
    .eq("member_id", memberId)
    .eq("verification_status", "CONFIRMED");
  if (error) throw new DataAccessError("restricciones confirmadas", error);

  const requeridos = z
    .array(z.object({ code: z.string(), max_age_days: z.number().int().nullable().catch(null) }))
    .catch([]);
  const fila = z.object({
    id: uuid,
    type: z.string(),
    target: z.string(),
    value: nullableNumeric,
    unit: z.string().nullable(),
    severity: z.string(),
    source: z.string(),
    rule_version_id: uuid.nullable(),
    valid_from: dateString,
    valid_until: dateString.nullable(),
    clinical_rule_versions: z
      .union([
        z.object({ required_inputs: z.unknown() }),
        z.array(z.object({ required_inputs: z.unknown() })),
        z.null(),
      ])
      .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
  });
  return parseRows(fila, data, "restricciones confirmadas").map((f) => ({
    id: f.id,
    type: f.type as ClinicalRestriction["type"],
    target: f.target,
    value: f.value,
    unit: f.unit,
    severity: f.severity as ClinicalRestriction["severity"],
    source: f.source,
    ruleVersionId: f.rule_version_id,
    requiredBiomarkers: requeridos
      .parse(f.clinical_rule_versions?.required_inputs ?? [])
      .map((r) => ({ code: r.code, maxAgeDays: r.max_age_days })),
    validFrom: f.valid_from,
    validUntil: f.valid_until,
  }));
}

export async function loadScheduleInputs(db: Db, memberId: string): Promise<LabScheduleInput[]> {
  const { data, error } = await db
    .from("member_lab_schedules")
    .select("expected_interval_days, source, biomarker_definitions ( code )")
    .eq("member_id", memberId)
    .eq("enabled", true);
  if (error) throw new DataAccessError("frecuencias para el motor", error);
  const fila = z.object({
    expected_interval_days: z.number().int().nullable(),
    source: z.string(),
    biomarker_definitions: z
      .union([z.object({ code: z.string() }), z.array(z.object({ code: z.string() })), z.null()])
      .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
  });
  return parseRows(fila, data, "frecuencias para el motor").map((f) => ({
    biomarkerCode: f.biomarker_definitions?.code ?? null,
    intervalDays: f.expected_interval_days,
    source: f.source,
  }));
}

// ---------------------------------------------------------------------------
// ¿De quién puedo ver salud? — self, grants hacia mí, dependientes si soy admin
// ---------------------------------------------------------------------------

export interface AccessibleMember {
  id: string;
  displayName: string;
  relation: "SELF" | "GRANTED" | "DEPENDENT";
}

export async function loadAccessibleMembers(db: Db): Promise<AccessibleMember[]> {
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return [];

  const { data: miembros, error } = await db
    .from("household_members")
    .select("id, display_name, user_id")
    .eq("is_active", true);
  if (error) throw new DataAccessError("integrantes", error);
  const filas = parseRows(
    z.object({ id: uuid, display_name: z.string(), user_id: uuid.nullable() }),
    miembros,
    "integrantes",
  );
  const mios = filas.filter((m) => m.user_id === user.id).map((m) => m.id);

  // Grants vivos hacia MIS members (RLS ya me muestra solo los que me tocan).
  const { data: grants, error: grantsError } = await db
    .from("medical_data_grants")
    .select("owner_member_id, grantee_member_id, permission, revoked_at")
    .is("revoked_at", null)
    .eq("permission", "READ_LABS");
  if (grantsError) throw new DataAccessError("permisos hacia mí", grantsError);
  const otorgados = new Set(
    parseRows(
      z.object({ owner_member_id: uuid, grantee_member_id: uuid }).passthrough(),
      grants,
      "permisos hacia mí",
    )
      .filter((g) => mios.includes(g.grantee_member_id))
      .map((g) => g.owner_member_id),
  );

  // ¿Soy admin? (para dependientes sin cuenta — regla del tutor, ADR 0012)
  const { data: roles, error: rolesError } = await db
    .from("member_role_assignments")
    .select("member_id, household_roles ( is_admin )")
    .in("member_id", mios.length > 0 ? mios : ["00000000-0000-0000-0000-000000000000"]);
  if (rolesError) throw new DataAccessError("roles", rolesError);
  const soyAdmin = parseRows(
    z.object({
      member_id: uuid,
      household_roles: z
        .union([z.object({ is_admin: z.boolean() }), z.array(z.object({ is_admin: z.boolean() })), z.null()])
        .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v)),
    }),
    roles,
    "roles",
  ).some((r) => r.household_roles?.is_admin === true);

  return filas
    .map((m): AccessibleMember | null => {
      if (m.user_id === user.id) return { id: m.id, displayName: m.display_name, relation: "SELF" };
      if (otorgados.has(m.id)) return { id: m.id, displayName: m.display_name, relation: "GRANTED" };
      if (m.user_id === null && soyAdmin)
        return { id: m.id, displayName: m.display_name, relation: "DEPENDENT" };
      return null;
    })
    .filter((x): x is AccessibleMember => x !== null);
}
