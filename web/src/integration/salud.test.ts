import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { crearHogar, levantarBase, type Harness } from "./harness";

/**
 * SPRINT 11 — Salud: pipeline de exámenes, grants médicos, reglas versionadas
 * e inmutabilidad de la historia. Datos 100% SINTÉTICOS (§66-§67): jamás
 * datos médicos reales en tests automatizados.
 *
 * La novedad estructural de este sprint: aislamiento INTRA-hogar (§49/§80).
 * Ana y Bruno comparten hogar; Bruno NO lee los exámenes de Ana sin grant.
 */

const USER_ANA = "00000000-0000-0000-0000-000000011a01";
const USER_BRUNO = "00000000-0000-0000-0000-000000011a02";
const USER_VECINA = "00000000-0000-0000-0000-000000011b01";

let h: Harness;
let hogarA: { householdId: string; memberId: string }; // Ana (dueña de los datos)
let bruno: string;   // member de Bruno en el hogar de Ana
let demoNino: string; // dependiente SIN cuenta (tutor = admin)
let docAna: string;

beforeAll(async () => {
  h = await levantarBase();
  hogarA = await crearHogar(h, USER_ANA, "Salud A", "Ana");
  await crearHogar(h, USER_VECINA, "Salud B", "Vecina");

  // Bruno: segundo usuario REAL dentro del hogar de Ana.
  await h.comoAdmin(async () => {
    await h.db.query("insert into auth.users (id, email) values ($1, 'bruno@test.dev')", [USER_BRUNO]);
    bruno = (await h.fila<{ id: string }>(
      `insert into public.household_members (household_id, user_id, display_name)
       values ($1, $2, 'Bruno') returning id`,
      [hogarA.householdId, USER_BRUNO],
    ))!.id;
    demoNino = (await h.fila<{ id: string }>(
      `insert into public.household_members (household_id, display_name)
       values ($1, 'Demo Niño') returning id`,
      [hogarA.householdId],
    ))!.id;
  });

});

afterAll(async () => {
  await h?.cerrar();
});

// ---------------------------------------------------------------------------
// Pipeline: subir → consentir → extraer → revisar → confirmar
// ---------------------------------------------------------------------------

describe("pipeline de examen (§3/§4/§9/§10)", () => {
  it("Ana sube su examen; sin consentimiento la extracción por IA REBOTA", async () => {
    await h.como(USER_ANA, async () => {
      docAna = (await h.fila<{ upload_lab_document: string }>(
        `select public.upload_lab_document($1, '2026-08-20', 'Lab Sintético Demo', 'LAB_RESULTS', null)`,
        [hogarA.memberId],
      ))!.upload_lab_document;

      await expect(
        h.db.query("select public.submit_lab_extraction($1, 'demo-parser/1.0.0', $2::jsonb)", [
          docAna,
          JSON.stringify([{ biomarker_code: "potassium", raw_label: "Potasio", value: 4.5, unit: "mmol/L", confidence: 0.9 }]),
        ]),
      ).rejects.toThrow(/Sin consentimiento/);
    });
  });

  it("con consentimiento explícito, los candidatos entran (uno SIN unidad → NEEDS_REVIEW)", async () => {
    await h.como(USER_ANA, async () => {
      await h.db.query("select public.set_lab_ai_consent($1, true, 'extraer biomarcadores del examen')", [docAna]);
      const n = (await h.fila<{ submit_lab_extraction: number }>(
        "select public.submit_lab_extraction($1, 'demo-parser/1.0.0', $2::jsonb)",
        [
          docAna,
          JSON.stringify([
            { biomarker_code: "potassium", raw_label: "Potasio", value: 4.5, unit: "mmol/L", reference_low: 3.5, reference_high: 5.1, confidence: 0.9, original_snippet: "Potasio: 4.5 mmol/L (3.5-5.1)" },
            // §7: el examen dice "Fósforo: 3.8" sin unidad. Se guarda unit NULL.
            { biomarker_code: "phosphorus", raw_label: "Fósforo", value: 3.8, confidence: 0.6, original_snippet: "Fósforo: 3.8" },
          ]),
        ],
      ))!.submit_lab_extraction;
      expect(n).toBe(2);

      const doc = await h.fila<{ processing_status: string; ai_consent_status: string }>(
        "select processing_status::text, ai_consent_status::text from public.lab_documents where id = $1",
        [docAna],
      );
      expect(doc!.processing_status).toBe("NEEDS_REVIEW"); // hay una fila dudosa
      expect(doc!.ai_consent_status).toBe("GRANTED");

      const sinUnidad = await h.fila<{ unit: string | null }>(
        "select unit from public.lab_extraction_candidates where document_id = $1 and raw_label = 'Fósforo'",
        [docAna],
      );
      expect(sinUnidad!.unit).toBeNull(); // jamás se asumió mmol/L
    });
  });

  it("§68: lo extraído SIN confirmar NO produce observaciones (el motor no lo ve)", async () => {
    await h.como(USER_ANA, async () => {
      const obs = await h.filas(
        "select id from public.lab_observations where member_id = $1",
        [hogarA.memberId],
      );
      expect(obs).toHaveLength(0);
    });
  });

  it("la revisión humana confirma una fila, EDITA la otra (agregando la unidad) y crea observaciones", async () => {
    await h.como(USER_ANA, async () => {
      const cands = await h.filas<{ id: string; raw_label: string }>(
        "select id, raw_label from public.lab_extraction_candidates where document_id = $1 and status = 'PENDING'",
        [docAna],
      );
      const potasio = cands.find((c) => c.raw_label === "Potasio")!;
      const fosforo = cands.find((c) => c.raw_label === "Fósforo")!;

      const r = (await h.fila<{ confirm_lab_extraction: { confirmed: number; discarded: number } }>(
        "select public.confirm_lab_extraction($1, $2::jsonb)",
        [
          docAna,
          JSON.stringify([
            { candidate_id: potasio.id, action: "CONFIRM" },
            { candidate_id: fosforo.id, action: "EDIT", unit: "mg/dL" },
          ]),
        ],
      ))!.confirm_lab_extraction;
      expect(r.confirmed).toBe(2);

      const doc = await h.fila<{ processing_status: string }>(
        "select processing_status::text from public.lab_documents where id = $1",
        [docAna],
      );
      expect(doc!.processing_status).toBe("CONFIRMED");

      const obs = await h.filas<{ unit: string | null; value: string; reference_low: string | null }>(
        `select unit, value::text, reference_low::text from public.lab_observations
         where member_id = $1 and verification_status = 'CONFIRMED' order by unit`,
        [hogarA.memberId],
      );
      expect(obs).toHaveLength(2);
      // El rango IMPRESO por el laboratorio quedó en la observación (§8).
      expect(obs.find((o) => o.unit === "mmol/L")!.reference_low).toBe("3.5000");
    });
  });

  it("§86: doble confirmación simultánea = una sola tanda de observaciones", async () => {
    await h.como(USER_ANA, async () => {
      const doc2 = (await h.fila<{ upload_lab_document: string }>(
        "select public.upload_lab_document($1, '2026-08-22', 'Lab Sintético', 'LAB_RESULTS', null)",
        [hogarA.memberId],
      ))!.upload_lab_document;
      await h.db.query("select public.set_lab_ai_consent($1, true, 'demo')", [doc2]);
      await h.db.query("select public.submit_lab_extraction($1, 'demo-parser/1.0.0', $2::jsonb)", [
        doc2,
        JSON.stringify([{ biomarker_code: "glucose", raw_label: "Glucosa", value: 92, unit: "mg/dL", confidence: 0.9 }]),
      ]);
      const cand = (await h.fila<{ id: string }>(
        "select id from public.lab_extraction_candidates where document_id = $1",
        [doc2],
      ))!.id;
      const decisiones = JSON.stringify([{ candidate_id: cand, action: "CONFIRM" }]);
      await Promise.allSettled([
        h.db.query("select public.confirm_lab_extraction($1, $2::jsonb)", [doc2, decisiones]),
        h.db.query("select public.confirm_lab_extraction($1, $2::jsonb)", [doc2, decisiones]),
      ]);
      const obs = await h.filas(
        `select o.id from public.lab_observations o
         where o.document_id = $1 and o.verification_status = 'CONFIRMED'`,
        [doc2],
      );
      expect(obs).toHaveLength(1); // el reintento del candidato ya no-PENDING es no-op
    });
  });
});

// ---------------------------------------------------------------------------
// §70 — Corrección auditable
// ---------------------------------------------------------------------------

describe("corrección (§11/§70)", () => {
  it("corregir 4.5 → 5.4 conserva AMBAS: la vieja CORRECTED, la nueva vigente y encadenada", async () => {
    await h.como(USER_ANA, async () => {
      const original = (await h.fila<{ id: string }>(
        `select id from public.lab_observations
         where member_id = $1 and unit = 'mmol/L' and verification_status = 'CONFIRMED'`,
        [hogarA.memberId],
      ))!.id;

      await expect(
        h.db.query("select public.correct_lab_observation($1, 5.4, 'mmol/L', '')", [original]),
      ).rejects.toThrow(/porqué/); // la corrección exige razón

      const nueva = (await h.fila<{ correct_lab_observation: string }>(
        "select public.correct_lab_observation($1, 5.4, 'mmol/L', 'error de tipeo en la revisión')",
        [original],
      ))!.correct_lab_observation;

      const vieja = await h.fila<{ verification_status: string; value: string }>(
        "select verification_status::text, value::text from public.lab_observations where id = $1",
        [original],
      );
      expect(vieja!.verification_status).toBe("CORRECTED");
      expect(vieja!.value).toBe("4.5000"); // la historia conserva el valor original

      const corregida = await h.fila<{ corrected_from: string; value: string; verification_status: string }>(
        "select corrected_from, value::text, verification_status::text from public.lab_observations where id = $1",
        [nueva],
      );
      expect(corregida!.corrected_from).toBe(original);
      expect(corregida!.value).toBe("5.4000");
      expect(corregida!.verification_status).toBe("CONFIRMED");

      // Y una observación ya corregida no se vuelve a corregir (cadena limpia).
      await expect(
        h.db.query("select public.correct_lab_observation($1, 6.0, 'mmol/L', 'x')", [original]),
      ).rejects.toThrow(/solo se corrige/);
    });
  });
});

// ---------------------------------------------------------------------------
// §79/§80/§81 — RLS: cross-household + INTRA-household + revocación
// ---------------------------------------------------------------------------

describe("privacidad médica", () => {
  it("§79: la vecina (otro hogar) no ve NADA de Ana", async () => {
    await h.como(USER_VECINA, async () => {
      expect(await h.filas("select id from public.lab_documents")).toHaveLength(0);
      expect(await h.filas("select id from public.lab_observations")).toHaveLength(0);
      await expect(
        h.db.query("select public.confirm_lab_extraction($1, '[]'::jsonb)", [docAna]),
      ).rejects.toThrow(/no autorizado/);
    });
  });

  it("§80: Bruno (MISMO hogar, ADMIN no es) no lee los labs de Ana sin grant", async () => {
    await h.como(USER_BRUNO, async () => {
      expect(await h.filas("select id from public.lab_documents where member_id = $1", [hogarA.memberId])).toHaveLength(0);
      expect(await h.filas("select id from public.lab_observations where member_id = $1", [hogarA.memberId])).toHaveLength(0);
      await expect(
        h.db.query("select public.upload_lab_document($1, current_date, 'x', 'LAB_RESULTS', null)", [hogarA.memberId]),
      ).rejects.toThrow(/no autorizado/);
    });
  });

  it("ni siquiera el ADMIN del hogar (Ana) lee los labs de Bruno: el rol no es un grant", async () => {
    // Bruno sube SU examen; Ana, aunque creó el hogar (ADMIN), no lo ve.
    let docBruno = "";
    await h.como(USER_BRUNO, async () => {
      docBruno = (await h.fila<{ upload_lab_document: string }>(
        "select public.upload_lab_document($1, current_date, 'Lab B', 'LAB_RESULTS', null)",
        [bruno],
      ))!.upload_lab_document;
    });
    await h.como(USER_ANA, async () => {
      expect(await h.filas("select id from public.lab_documents where id = $1", [docBruno])).toHaveLength(0);
    });
  });

  it("§80: con grant READ_LABS Bruno lee; solo lo concedido (no puede confirmar)", async () => {
    await h.como(USER_ANA, async () => {
      await h.db.query("select public.grant_medical_access($1, $2, 'READ_LABS')", [hogarA.memberId, bruno]);
    });
    await h.como(USER_BRUNO, async () => {
      const docs = await h.filas("select id from public.lab_documents where member_id = $1", [hogarA.memberId]);
      expect(docs.length).toBeGreaterThan(0);
      // Pero CONFIRM_LABS no fue concedido:
      await expect(
        h.db.query("select public.confirm_lab_extraction($1, '[]'::jsonb)", [docAna]),
      ).rejects.toThrow(/no autorizado/);
    });
  });

  it("§81: revocar el grant corta el acceso INMEDIATAMENTE", async () => {
    await h.como(USER_ANA, async () => {
      const grant = (await h.fila<{ id: string }>(
        `select id from public.medical_data_grants
         where owner_member_id = $1 and grantee_member_id = $2 and revoked_at is null`,
        [hogarA.memberId, bruno],
      ))!.id;
      await h.db.query("select public.revoke_medical_access($1)", [grant]);
    });
    await h.como(USER_BRUNO, async () => {
      expect(await h.filas("select id from public.lab_documents where member_id = $1", [hogarA.memberId])).toHaveLength(0);
    });
  });

  it("tutor de dependiente: el ADMIN gestiona los datos del niño SIN cuenta (regla explícita del ADR)", async () => {
    await h.como(USER_ANA, async () => {
      const doc = (await h.fila<{ upload_lab_document: string }>(
        "select public.upload_lab_document($1, current_date, 'Lab Niño', 'LAB_RESULTS', null)",
        [demoNino],
      ))!.upload_lab_document;
      expect(doc).toBeTruthy();
    });
    // Bruno NO es admin: no toca los datos del niño.
    await h.como(USER_BRUNO, async () => {
      await expect(
        h.db.query("select public.upload_lab_document($1, current_date, 'x', 'LAB_RESULTS', null)", [demoNino]),
      ).rejects.toThrow(/no autorizado/);
    });
  });
});

// ---------------------------------------------------------------------------
// §19/§22/§87 — Restricciones y reglas versionadas
// ---------------------------------------------------------------------------

describe("restricciones y reglas", () => {
  let reglaV1 = "";
  let restriccion = "";

  it("una regla se crea, se publica y queda INMUTABLE", async () => {
    await h.como(USER_ANA, async () => {
      reglaV1 = (await h.fila<{ create_clinical_rule_version: string }>(
        `select public.create_clinical_rule_version(
           'demo-nutrient-x', 'Demo Nutrient X', 'USER_CONFIRMED_LIMIT',
           'perfil demo sintético §66', '{"nutrient":"phosphorus_mg","max":500}'::jsonb,
           '[]'::jsonb, 'Demo Tester')`,
      ))!.create_clinical_rule_version;
      await h.db.query("select public.publish_clinical_rule_version($1)", [reglaV1]);

      // Capa 1 (RLS): el cliente ni siquiera alcanza la fila.
      const upd = await h.db.query(
        "update public.clinical_rule_versions set logic = '{}'::jsonb where id = $1",
        [reglaV1],
      );
      expect((upd as { affectedRows?: number }).affectedRows ?? 0).toBe(0);
    });
    // Capa 2 (trigger): ni siquiera un camino con privilegios la edita.
    await h.comoAdmin(async () => {
      await expect(
        h.db.query("update public.clinical_rule_versions set logic = '{}'::jsonb where id = $1", [reglaV1]),
      ).rejects.toThrow(/inmutable/);
      await expect(
        h.db.query("delete from public.clinical_rule_versions where id = $1", [reglaV1]),
      ).rejects.toThrow(/historia/);
    });
  });

  it("§87: publicar v2 retira v1 SIN tocar su contenido; ambas siguen legibles", async () => {
    await h.como(USER_ANA, async () => {
      const v2 = (await h.fila<{ create_clinical_rule_version: string }>(
        `select public.create_clinical_rule_version(
           'demo-nutrient-x', 'Demo Nutrient X', 'USER_CONFIRMED_LIMIT',
           'ajuste demo', '{"nutrient":"phosphorus_mg","max":450}'::jsonb,
           '[]'::jsonb, 'Demo Tester')`,
      ))!.create_clinical_rule_version;
      await h.db.query("select public.publish_clinical_rule_version($1)", [v2]);

      const versiones = await h.filas<{ version: number; status: string; logic: { max: number } }>(
        `select v.version, v.status::text, v.logic from public.clinical_rule_versions v
         join public.clinical_rule_sets s on s.id = v.rule_set_id
         where s.code = 'demo-nutrient-x' order by v.version`,
      );
      expect(versiones).toHaveLength(2);
      expect(versiones[0]!.status).toBe("RETIRED");
      expect(versiones[0]!.logic.max).toBe(500); // v1 intacta: la historia la cita
      expect(versiones[1]!.status).toBe("PUBLISHED");
    });
  });

  it("un límite de nutriente SIN unidad se rechaza: sin unidad no hay límite", async () => {
    await h.como(USER_ANA, async () => {
      await expect(
        h.db.query(
          `select public.create_clinical_restriction($1, 'NUTRIENT_MAX', 'phosphorus_mg',
             500, null, 'HARD', 'USER_CONFIRMED_LIMIT', null, null, 'demo', true)`,
          [hogarA.memberId],
        ),
      ).rejects.toThrow(/unidad/);
    });
  });

  it("la restricción confirmada existe con fuente y confirmador", async () => {
    await h.como(USER_ANA, async () => {
      restriccion = (await h.fila<{ create_clinical_restriction: string }>(
        `select public.create_clinical_restriction($1, 'NUTRIENT_MAX', 'phosphorus_mg',
           500, 'mg', 'HARD', 'USER_CONFIRMED_LIMIT', 'perfil demo §66', null, 'límite demo sintético', true)`,
        [hogarA.memberId],
      ))!.create_clinical_restriction;
      const r = await h.fila<{ verification_status: string; confirmed_by: string | null; source: string }>(
        "select verification_status::text, confirmed_by, source::text from public.member_clinical_restrictions where id = $1",
        [restriccion],
      );
      expect(r!.verification_status).toBe("CONFIRMED");
      expect(r!.confirmed_by).not.toBeNull();
      expect(r!.source).toBe("USER_CONFIRMED_LIMIT");
    });
  });

  it("§22: Bruno sin grant no VE ni TOCA las restricciones de Ana (la UI de preferencias no tiene puerta)", async () => {
    await h.como(USER_BRUNO, async () => {
      expect(
        await h.filas("select id from public.member_clinical_restrictions where member_id = $1", [hogarA.memberId]),
      ).toHaveLength(0);
      await expect(
        h.db.query("select public.set_clinical_restriction_status($1, 'RETIRED', 'x')", [restriccion]),
      ).rejects.toThrow(/no autorizado/);
      // Tampoco por UPDATE directo (RLS sin política de escritura):
      const upd = await h.db.query(
        "update public.member_clinical_restrictions set verification_status = 'RETIRED' where id = $1",
        [restriccion],
      );
      expect((upd as { affectedRows?: number }).affectedRows ?? 0).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// §75-§78 — Impacto: proponer sí, reescribir jamás
// ---------------------------------------------------------------------------

describe("impact reviews e historia", () => {
  it("§34: la creación es idempotente (mismo disparador = una revisión)", async () => {
    await h.como(USER_ANA, async () => {
      const a = (await h.fila<{ create_clinical_impact_review: string }>(
        "select public.create_clinical_impact_review($1, 'LAB_RESULTS_CONFIRMED', $2, '{}'::jsonb)",
        [hogarA.memberId, docAna],
      ))!.create_clinical_impact_review;
      const b = (await h.fila<{ create_clinical_impact_review: string }>(
        "select public.create_clinical_impact_review($1, 'LAB_RESULTS_CONFIRMED', $2, '{}'::jsonb)",
        [hogarA.memberId, docAna],
      ))!.create_clinical_impact_review;
      expect(a).toBe(b);
    });
  });

  it("§37/§78: marcar CLINICALLY_INVALIDATED funciona en PLANNED y REBOTA en CONSUMED", async () => {
    // Se construye una comida confirmada real y se consume; luego una nueva
    // restricción intenta tocar ambas clases de porción.
    await h.como(USER_ANA, async () => {
      const version = (await h.fila<{ id: string; template_id: string }>(
        "select id, template_id from public.meal_template_versions where status = 'PUBLISHED' limit 1",
      ))!;
      const perfil = (await h.fila<{ publish_nutrition_profile: string }>(
        `select public.publish_nutrition_profile($1, 'BASIC', 'firma-salud', '{}'::jsonb,
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'salud')`,
        [hogarA.memberId],
      ))!.publish_nutrition_profile;
      const plan = (await h.fila<{ ensure_weekly_plan: string }>(
        "select public.ensure_weekly_plan($1, (date_trunc('week', current_date))::date)",
        [hogarA.householdId],
      ))!.ensure_weekly_plan;
      const dias = await h.filas<{ id: string }>(
        "select id from public.weekly_plan_days where plan_id = $1 order by plan_date limit 2",
        [plan],
      );

      const confirmar = async (diaId: string, meal: string) => {
        const asig = (await h.fila<{ id: string }>(
          `insert into public.meal_assignments (day_id, meal_type, kind, template_id, version_id)
           values ($1, $2::public.meal_type, 'RECIPE', $3, $4) returning id`,
          [diaId, meal, version.template_id, version.id],
        ))!.id;
        await h.db.query("select public.confirm_meal_assignment($1, $2::jsonb)", [
          asig,
          JSON.stringify([{
            member_id: hogarA.memberId, version_id: version.id, profile_id: perfil,
            optimizer_version: "portion-optimizer/1.0.0", meal_type: meal,
            serving_date: "2026-08-25", fit: "COMPATIBLE", adaptation_level: 0, score: 90,
            nutrition: {}, completeness: {}, reasons: [], unmet_constraints: [],
            components: [], substitutions: [],
          }]),
        ]);
        return (await h.fila<{ id: string }>(
          "select id from public.member_serving_projections where assignment_id = $1",
          [asig],
        ))!.id;
      };

      const proyFutura = await confirmar(dias[0]!.id, "LUNCH");
      const proyConsumida = await confirmar(dias[1]!.id, "DINNER");
      const asigConsumida = (await h.fila<{ assignment_id: string }>(
        "select assignment_id from public.member_serving_projections where id = $1",
        [proyConsumida],
      ))!.assignment_id;
      await h.db.query("select public.consume_planned_meal($1)", [asigConsumida]);

      // La futura SÍ se marca:
      await h.db.query("select public.set_serving_clinical_status($1, 'CLINICALLY_INVALIDATED', null)", [proyFutura]);
      const marcada = await h.fila<{ clinical_status: string }>(
        "select clinical_status::text from public.member_serving_projections where id = $1",
        [proyFutura],
      );
      expect(marcada!.clinical_status).toBe("CLINICALLY_INVALIDATED");

      // La consumida es HISTORIA:
      await expect(
        h.db.query("select public.set_serving_clinical_status($1, 'CLINICALLY_INVALIDATED', null)", [proyConsumida]),
      ).rejects.toThrow(/historia/);
    });
  });

  it("§76/§77: resolver un impacto NO toca lotes ni movimientos (la física es intocable)", async () => {
    await h.como(USER_ANA, async () => {
      const movsAntes = (await h.fila<{ n: string }>("select count(*)::text as n from public.inventory_movements"))!.n;
      const lotesAntes = (await h.fila<{ n: string }>("select count(*)::text as n from public.inventory_lots"))!.n;

      const review = (await h.fila<{ create_clinical_impact_review: string }>(
        "select public.create_clinical_impact_review($1, 'CLINICAL_RESTRICTION_CHANGED', gen_random_uuid(), '{\"affected_meals\":1}'::jsonb)",
        [hogarA.memberId],
      ))!.create_clinical_impact_review;
      await h.db.query("select public.resolve_clinical_impact_review($1, 'APPLIED', '[]'::jsonb)", [review]);

      expect((await h.fila<{ n: string }>("select count(*)::text as n from public.inventory_movements"))!.n).toBe(movsAntes);
      expect((await h.fila<{ n: string }>("select count(*)::text as n from public.inventory_lots"))!.n).toBe(lotesAntes);
    });
  });

  it("§82: Bruno (cocina, sin grant) ve el ESTADO del serving pero no la evaluación", async () => {
    await h.como(USER_BRUNO, async () => {
      // El estado clínico del serving es divulgación mínima: visible.
      const servings = await h.filas<{ clinical_status: string | null }>(
        `select p.clinical_status::text from public.member_serving_projections p
         where p.clinical_status is not null`,
      );
      expect(servings.length).toBeGreaterThan(0);
      // La evaluación clínica (razones, valores) NO:
      expect(await h.filas("select id from public.meal_clinical_assessments")).toHaveLength(0);
    });
  });
});
