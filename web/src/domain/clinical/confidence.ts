import { labRecency } from "./engine";
import type {
  ClinicalRestriction,
  ConfirmedObservation,
  LabScheduleInput,
} from "./types";

/**
 * NutritionDataConfidence (§17): calidad/actualidad de los datos necesarios
 * para PERSONALIZAR la alimentación. NO es un health score y no opina sobre
 * la salud de nadie: opina sobre nuestros DATOS.
 */

export interface NutritionDataConfidence {
  level: "LOW" | "MEDIUM" | "HIGH";
  reasons: { code: string; text: string }[];
}

export function nutritionDataConfidence(input: {
  date: string;
  restrictions: readonly ClinicalRestriction[];
  observations: readonly ConfirmedObservation[];
  schedules: readonly LabScheduleInput[];
  unverifiedObservationCount: number;
  pendingImpactReviews: number;
}): NutritionDataConfidence {
  const reasons: NutritionDataConfidence["reasons"] = [];
  let puntos = 0; // 0 = sin problemas; cada hallazgo suma gravedad.

  // Biomarcadores que las reglas confirmadas EXIGEN.
  const exigidos = new Map<string, number | null>();
  for (const r of input.restrictions) {
    for (const req of r.requiredBiomarkers) {
      exigidos.set(req.code, req.maxAgeDays);
    }
  }
  for (const [code, maxAge] of exigidos) {
    const rec = labRecency(code, input.date, input.observations, input.schedules, maxAge);
    if (rec.status === "MISSING") {
      puntos += 3;
      reasons.push({ code: "LAB_MISSING", text: `Falta un resultado confirmado de ${code}.` });
    } else if (rec.status === "OUTDATED") {
      puntos += 2;
      reasons.push({ code: "LAB_OUTDATED", text: `El último ${code} está vencido para las reglas activas.` });
    } else if (rec.status === "EXPIRING_SOON") {
      puntos += 1;
      reasons.push({ code: "LAB_EXPIRING", text: `El ${code} vence pronto.` });
    }
  }

  const sinUnidad = input.observations.filter((o) => o.unit === null).length;
  if (sinUnidad > 0) {
    puntos += 2;
    reasons.push({ code: "UNIT_UNKNOWN", text: `${sinUnidad} resultado(s) confirmados sin unidad.` });
  }
  if (input.unverifiedObservationCount > 0) {
    puntos += 1;
    reasons.push({
      code: "UNVERIFIED_DATA",
      text: `${input.unverifiedObservationCount} dato(s) extraídos esperan revisión humana.`,
    });
  }
  if (input.pendingImpactReviews > 0) {
    puntos += 2;
    reasons.push({
      code: "PENDING_IMPACT",
      text: `${input.pendingImpactReviews} revisión(es) de impacto clínico sin resolver.`,
    });
  }
  if (reasons.length === 0) {
    reasons.push({ code: "ALL_CURRENT", text: "Los datos requeridos están confirmados y vigentes." });
  }

  return { level: puntos >= 4 ? "LOW" : puntos >= 1 ? "MEDIUM" : "HIGH", reasons };
}
