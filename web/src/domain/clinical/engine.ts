import { NUTRIENT_KEYS, type NutrientKey } from "@/domain/catalog/types";
import {
  CLINICAL_ENGINE_VERSION,
  FUENTES_INDIVIDUALES,
  type ClinicalAssessment,
  type ClinicalAssessmentInput,
  type ClinicalAssessmentStatus,
  type ClinicalReason,
  type ClinicalRestriction,
  type ConfirmedObservation,
  type LabRecencyStatus,
  type LabScheduleInput,
} from "./types";

/**
 * ClinicalRulesEngine — `clinical-rules/1.0.0` (ADR 0012).
 *
 * Determinista y puro: mismas entradas, misma salida, byte a byte. Nada de
 * IA, nada de reloj propio (la fecha viene en el input), nada de límites
 * inventados: cada veredicto cita SU restricción y SU versión de regla.
 *
 * La regla madre: UNKNOWN NEVER MEANS NORMAL. Ante datos incompletos el
 * motor prefiere REVIEW_REQUIRED a una falsa afirmación de seguridad — y lo
 * dice con la razón exacta de qué faltó.
 */

const dentroDeVigencia = (r: ClinicalRestriction, date: string): boolean =>
  r.validFrom <= date && (r.validUntil === null || date <= r.validUntil);

/** Unidad implícita de cada NutrientKey (la clave la lleva en el sufijo). */
function unidadDeNutriente(key: NutrientKey): string {
  if (key === "energy_kcal") return "kcal";
  if (key.endsWith("_mg")) return "mg";
  return "g";
}

const esNutrientKey = (t: string): t is NutrientKey =>
  (NUTRIENT_KEYS as readonly string[]).includes(t);

/**
 * Restricciones cuya seguridad depende de CUÁNTO come esta persona. Una
 * exclusión de alimento no: si el plato lo trae, lo trae para todos.
 */
const dependeDeCantidadIndividual = (t: ClinicalRestriction["type"]): boolean =>
  t === "NUTRIENT_MAX" || t === "NUTRIENT_MIN" || t === "PORTION_MAX" || t === "PORTION_MIN";

function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

/**
 * Vigencia de un biomarcador (§14): el intervalo SIEMPRE viene configurado
 * por alguien (USER/DOCTOR/NUTRITIONIST/PROTOCOL); la app jamás lo inventa.
 */
export function labRecency(
  biomarkerCode: string,
  today: string,
  observations: readonly ConfirmedObservation[],
  schedules: readonly LabScheduleInput[],
  overrideMaxAgeDays: number | null = null,
): { status: LabRecencyStatus; lastDate: string | null; intervalDays: number | null } {
  const propias = observations
    .filter((o) => o.biomarkerCode === biomarkerCode && o.collectedDate !== null)
    .sort((a, b) => (a.collectedDate! < b.collectedDate! ? 1 : -1));
  const ultima = propias[0]?.collectedDate ?? null;

  const schedule = schedules.find((s) => s.biomarkerCode === biomarkerCode);
  const intervalo = overrideMaxAgeDays ?? schedule?.intervalDays ?? null;

  if (ultima === null) {
    return { status: "MISSING", lastDate: null, intervalDays: intervalo };
  }
  if (intervalo === null) {
    return { status: "NO_SCHEDULE_CONFIGURED", lastDate: ultima, intervalDays: null };
  }
  const edad = diasEntre(ultima, today);
  if (edad > intervalo) return { status: "OUTDATED", lastDate: ultima, intervalDays: intervalo };
  if (edad > intervalo * 0.8)
    return { status: "EXPIRING_SOON", lastDate: ultima, intervalDays: intervalo };
  return { status: "CURRENT", lastDate: ultima, intervalDays: intervalo };
}

export function assessClinical(input: ClinicalAssessmentInput): ClinicalAssessment {
  const reasons: ClinicalReason[] = [];
  const missingData: ClinicalAssessment["missingData"] = [];
  const violations: ClinicalAssessment["violations"] = [];
  const proposedAdjustments: ClinicalAssessment["proposedAdjustments"] = [];
  const observationRefs = new Set<string>();
  const ruleRefs: ClinicalAssessment["ruleRefs"] = [];

  // Nivel acumulado: 0 compatible, 1 caución, 2 revisión, 3 invalidada.
  let nivel = 0;
  const subir = (n: number) => {
    nivel = Math.max(nivel, n);
  };

  const fuente = input.nutritionSource;
  const esIndividual = FUENTES_INDIVIDUALES.includes(fuente);

  const activas = input.restrictions.filter((r) => dentroDeVigencia(r, input.date));

  for (const r of activas) {
    ruleRefs.push({ restrictionId: r.id, ruleVersionId: r.ruleVersionId });
    const razon = (
      code: ClinicalReason["code"],
      text: string,
      params: ClinicalReason["params"] = {},
    ) => reasons.push({ code, restrictionId: r.id, ruleVersionId: r.ruleVersionId, severity: r.severity, text, params });

    // --- Insumos de laboratorio que la regla exige vigentes (§28/§29/§69) ---
    let insumosOk = true;
    for (const req of r.requiredBiomarkers) {
      const rec = labRecency(req.code, input.date, input.observations, input.schedules, req.maxAgeDays);
      const obs = input.observations
        .filter((o) => o.biomarkerCode === req.code)
        .sort((a, b) => ((a.collectedDate ?? "") < (b.collectedDate ?? "") ? 1 : -1))[0];

      if (!obs) {
        missingData.push({ kind: "BIOMARKER", target: req.code, detail: "sin resultado confirmado" });
        razon("LAB_MISSING", `Esta regla necesita ${req.code} y no hay un resultado confirmado.`, { biomarker: req.code });
        insumosOk = false;
        continue;
      }
      observationRefs.add(obs.id);
      if (obs.unit === null) {
        missingData.push({ kind: "UNIT", target: req.code, detail: "unidad desconocida" });
        razon("LAB_UNIT_UNKNOWN", `El resultado de ${req.code} no tiene unidad confirmada: no se usa hasta aclararla.`, { biomarker: req.code });
        insumosOk = false;
        continue;
      }
      if (rec.status === "OUTDATED") {
        razon("LAB_OUTDATED", `El último ${req.code} (${rec.lastDate}) está vencido para esta regla: se necesita uno vigente.`, { biomarker: req.code, lastDate: rec.lastDate });
        insumosOk = false;
      }
    }
    if (!insumosOk) {
      subir(2); // REVIEW_REQUIRED: jamás se reusa un dato viejo/faltante como actual.
      continue;
    }

    // --- §1: SCREENING no es veredicto individual -------------------------
    // Una restricción cuantitativa evaluada contra el promedio de la olla NO
    // puede declarar segura la porción de NADIE: no sabe cuánto le van a
    // servir. Se evalúa igual (sirve para detectar un exceso evidente), pero
    // el "dentro del límite" nunca se convierte en COMPATIBLE fuerte.
    const soloScreening = dependeDeCantidadIndividual(r.type) && !esIndividual;

    // --- Por tipo ---
    if (r.type === "NUTRIENT_MAX" || r.type === "NUTRIENT_MIN") {
      if (!esNutrientKey(r.target)) {
        razon("UNIT_MISMATCH", `La restricción apunta a "${r.target}", que no es un nutriente del catálogo: revisión manual.`, { target: r.target });
        subir(2);
        continue;
      }
      const key = r.target;
      if (r.unit !== unidadDeNutriente(key)) {
        // Unidad del límite ≠ unidad del catálogo: convertir a ciegas sería
        // inventar un dato clínico.
        razon("UNIT_MISMATCH", `El límite está en "${r.unit ?? "?"}" y el catálogo mide ${key} en ${unidadDeNutriente(key)}: sin conversión validada no se verifica.`, { unit: r.unit, expected: unidadDeNutriente(key) });
        subir(2);
        continue;
      }
      const completeness = input.nutrition.completeness[key] ?? "UNKNOWN";
      const valor = input.nutrition.values[key] ?? null;

      if (r.type === "NUTRIENT_MAX") {
        if (completeness !== "COMPLETE" || valor === null) {
          // §27: PARTIAL jamás se trata como 0. Un techo no se declara
          // cumplido con datos incompletos — lo que falta solo puede sumar.
          missingData.push({ kind: "NUTRIENT", target: key, detail: `completeness ${completeness}` });
          razon("NUTRIENT_DATA_INCOMPLETE", `No contamos con información completa de ${key} para verificar esta restricción.`, { nutrient: key, completeness });
          if (valor !== null && r.value !== null && valor > r.value) {
            // Lo que YA se sabe excede el techo: peor que "no sé".
            violations.push({ restrictionId: r.id, severity: r.severity, detail: `${key} parcial ${valor} > máx ${r.value}` });
            razon("NUTRIENT_OVER_MAX", `Solo con lo conocido, ${key} (${valor}) ya excede el máximo ${r.value} ${r.unit}.`, { nutrient: key, value: valor, max: r.value });
            subir(r.severity === "HARD" || r.severity === "CRITICAL_REVIEW" ? 3 : 2);
          } else {
            subir(2);
          }
          continue;
        }
        if (r.value !== null && valor > r.value) {
          violations.push({ restrictionId: r.id, severity: r.severity, detail: `${key} ${valor} > máx ${r.value}` });
          razon("NUTRIENT_OVER_MAX", `${key} de la porción (${valor} ${r.unit}) excede el máximo confirmado de ${r.value} ${r.unit}.`, { nutrient: key, value: valor, max: r.value });
          if (r.severity === "HARD") {
            subir(3);
            proposedAdjustments.push({ kind: "NUTRIENT_CEILING", nutrient: key, max: r.value, restrictionId: r.id });
          } else if (r.severity === "CRITICAL_REVIEW") {
            subir(2);
          } else if (r.severity === "CAUTION") {
            subir(1);
          }
        } else if (soloScreening) {
          // Dentro del límite… PERO sobre la porción base de la receta.
          razon(
            "SCREENING_ONLY",
            `La porción base de la receta queda dentro del máximo de ${key} (${valor} ≤ ${r.value} ${r.unit}), pero esto es una evaluación PRELIMINAR: todavía no existe la porción de esta persona.`,
            { nutrient: key, value: valor, max: r.value, source: fuente },
          );
          // HARD/CRITICAL: la seguridad depende de la cantidad individual →
          // revisión hasta que exista esa porción. CAUTION/INFO: se anota.
          subir(r.severity === "HARD" || r.severity === "CRITICAL_REVIEW" ? 2 : 1);
          if (r.severity === "HARD" && r.value !== null) {
            proposedAdjustments.push({ kind: "NUTRIENT_CEILING", nutrient: key, max: r.value, restrictionId: r.id });
          }
        } else {
          razon("RESTRICTION_OK", `Dentro del máximo confirmado de ${key} (${valor} ≤ ${r.value} ${r.unit}).`, { nutrient: key, value: valor, max: r.value });
          if (r.severity === "HARD" && r.value !== null) {
            // El techo confirmado viaja igual al optimizador: recalcular una
            // porción no puede cruzarlo.
            proposedAdjustments.push({ kind: "NUTRIENT_CEILING", nutrient: key, max: r.value, restrictionId: r.id });
          }
        }
      } else {
        // NUTRIENT_MIN: asimétrico — lo que falta por conocer solo puede SUMAR.
        if (valor !== null && r.value !== null && valor >= r.value && soloScreening) {
          razon(
            "SCREENING_ONLY",
            `La porción base cumple el mínimo de ${key} (${valor} ≥ ${r.value} ${r.unit}), pero es PRELIMINAR: la porción de esta persona puede ser menor.`,
            { nutrient: key, value: valor, min: r.value, source: fuente },
          );
          subir(r.severity === "HARD" || r.severity === "CRITICAL_REVIEW" ? 2 : 1);
        } else if (valor !== null && r.value !== null && valor >= r.value) {
          razon("RESTRICTION_OK", `Cumple el mínimo confirmado de ${key} (${valor} ≥ ${r.value} ${r.unit}).`, { nutrient: key, value: valor, min: r.value });
        } else if (completeness !== "COMPLETE") {
          missingData.push({ kind: "NUTRIENT", target: key, detail: `completeness ${completeness}` });
          razon("NUTRIENT_DATA_INCOMPLETE", `No contamos con información completa de ${key} para verificar el mínimo.`, { nutrient: key, completeness });
          subir(2);
        } else {
          violations.push({ restrictionId: r.id, severity: r.severity, detail: `${key} ${valor} < mín ${r.value}` });
          razon("NUTRIENT_UNDER_MIN", `${key} (${valor ?? "sin dato"} ${r.unit}) queda bajo el mínimo confirmado de ${r.value} ${r.unit}.`, { nutrient: key, value: valor, min: r.value });
          subir(r.severity === "HARD" || r.severity === "CRITICAL_REVIEW" ? 3 : r.severity === "CAUTION" ? 1 : 0);
        }
      }
      continue;
    }

    if (r.type === "INGREDIENT_EXCLUDE" || r.type === "CATEGORY_EXCLUDE") {
      const presentes = r.type === "INGREDIENT_EXCLUDE" ? input.ingredientIds : input.categoryIds;
      if (presentes.includes(r.target)) {
        violations.push({ restrictionId: r.id, severity: r.severity, detail: `contiene ${r.target}` });
        razon(
          r.type === "INGREDIENT_EXCLUDE" ? "INGREDIENT_EXCLUDED" : "CATEGORY_EXCLUDED",
          "La comida contiene un elemento excluido por restricción clínica confirmada.",
          { target: r.target },
        );
        subir(r.severity === "HARD" || r.severity === "CRITICAL_REVIEW" ? 3 : r.severity === "CAUTION" ? 1 : 0);
      } else {
        razon("RESTRICTION_OK", "No contiene el elemento excluido.", { target: r.target });
      }
      continue;
    }

    if (r.type === "PORTION_MAX" || r.type === "PORTION_MIN") {
      const cantidad = input.quantitiesByIngredient[r.target];
      if (cantidad === undefined) {
        if (input.ingredientIds.includes(r.target)) {
          missingData.push({ kind: "NUTRIENT", target: r.target, detail: "cantidad de la porción desconocida" });
          razon("NUTRIENT_DATA_INCOMPLETE", "No se conoce la cantidad de la porción para verificar el límite.", { target: r.target });
          subir(2);
        } else {
          razon("RESTRICTION_OK", "El alimento limitado no está en esta comida.", { target: r.target });
        }
        continue;
      }
      if (r.type === "PORTION_MAX" && r.value !== null && cantidad > r.value) {
        violations.push({ restrictionId: r.id, severity: r.severity, detail: `porción ${cantidad} > máx ${r.value}` });
        razon("PORTION_OVER_MAX", `La porción (${cantidad} g) excede el máximo confirmado de ${r.value} g.`, { value: cantidad, max: r.value });
        subir(r.severity === "HARD" || r.severity === "CRITICAL_REVIEW" ? 3 : 1);
      } else if (r.type === "PORTION_MIN" && r.value !== null && cantidad < r.value) {
        violations.push({ restrictionId: r.id, severity: r.severity, detail: `porción ${cantidad} < mín ${r.value}` });
        razon("PORTION_UNDER_MIN", `La porción (${cantidad} g) queda bajo el mínimo confirmado de ${r.value} g.`, { value: cantidad, min: r.value });
        subir(r.severity === "HARD" || r.severity === "CRITICAL_REVIEW" ? 3 : 1);
      } else if (soloScreening) {
        razon(
          "SCREENING_ONLY",
          `La porción base queda dentro del límite (${cantidad} g), pero es PRELIMINAR: todavía no existe la porción de esta persona.`,
          { value: cantidad, source: fuente },
        );
        subir(r.severity === "HARD" || r.severity === "CRITICAL_REVIEW" ? 2 : 1);
      } else {
        razon("RESTRICTION_OK", "Porción dentro del límite confirmado.", { value: cantidad });
      }
      continue;
    }

    // MEAL_REQUIREMENT / REVIEW_REQUIRED / OTHER: exigen ojo humano.
    razon("REVIEW_RULE", "Esta restricción requiere revisión humana para esta comida.", { type: r.type });
    subir(2);
  }

  const status: ClinicalAssessmentStatus =
    nivel >= 3
      ? "CLINICALLY_INVALIDATED"
      : nivel === 2
        ? "REVIEW_REQUIRED"
        : nivel === 1
          ? "COMPATIBLE_WITH_CAUTION"
          : "COMPATIBLE";

  if (nivel === 1) {
    reasons.push({
      code: "CAUTION_NOTED",
      restrictionId: "",
      ruleVersionId: null,
      severity: "CAUTION",
      text: "Compatible, con precauciones anotadas por restricciones CAUTION.",
      params: {},
    });
  }

  return {
    engineVersion: CLINICAL_ENGINE_VERSION,
    status,
    nutritionSource: fuente,
    reasons,
    missingData,
    violations,
    proposedAdjustments,
    observationRefs: [...observationRefs].sort(),
    ruleRefs,
  };
}
