import { describe, expect, it } from "vitest";
import type { ClinicalAssessment } from "@/domain/clinical/types";
import { clinicalCeilingsFrom } from "./assess-service";

/**
 * Los techos que salen del motor clínico y entran al PortionOptimizer.
 *
 * Es la juntura donde el Sprint 11 se cortó: el optimizador aceptaba
 * `clinicalCeilings` y nadie se los pasaba. Acá se prueba la traducción, que
 * es la única lógica propia de esa juntura.
 */

const veredicto = (
  proposedAdjustments: ClinicalAssessment["proposedAdjustments"],
): ClinicalAssessment => ({
  engineVersion: "clinical-rules/1.0.0",
  status: "COMPATIBLE",
  nutritionSource: "PROJECTED_MEMBER_SERVING",
  reasons: [],
  missingData: [],
  violations: [],
  proposedAdjustments,
  observationRefs: [],
  ruleRefs: [],
});

describe("clinicalCeilingsFrom", () => {
  it("sin ajustes propuestos no hay techos: el caso sano no cambia en nada", () => {
    expect(clinicalCeilingsFrom(veredicto([]))).toEqual([]);
  });

  it("dos restricciones sobre el mismo nutriente: manda la MÁS BAJA, no la primera", () => {
    // El optimizador busca el techo por nutriente con `find`: si le llegaran
    // los dos, el orden de la consulta decidiría qué límite médico se respeta.
    const techos = clinicalCeilingsFrom(
      veredicto([
        { kind: "NUTRIENT_CEILING", nutrient: "protein_g", max: 60, restrictionId: "r-alta" },
        { kind: "NUTRIENT_CEILING", nutrient: "protein_g", max: 40, restrictionId: "r-baja" },
      ]),
    );
    expect(techos).toEqual([
      { nutrient: "protein_g", max: 40, restrictionId: "r-baja" },
    ]);
  });

  it("el orden de llegada no cambia el resultado (motor determinista)", () => {
    const a = clinicalCeilingsFrom(
      veredicto([
        { kind: "NUTRIENT_CEILING", nutrient: "sodium_mg", max: 800, restrictionId: "r-na" },
        { kind: "NUTRIENT_CEILING", nutrient: "protein_g", max: 40, restrictionId: "r-prot" },
      ]),
    );
    const b = clinicalCeilingsFrom(
      veredicto([
        { kind: "NUTRIENT_CEILING", nutrient: "protein_g", max: 40, restrictionId: "r-prot" },
        { kind: "NUTRIENT_CEILING", nutrient: "sodium_mg", max: 800, restrictionId: "r-na" },
      ]),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toHaveLength(2);
  });

  it("un techo que no es un número no se convierte en un límite inventado", () => {
    const techos = clinicalCeilingsFrom(
      veredicto([
        { kind: "NUTRIENT_CEILING", nutrient: "protein_g", max: Number.NaN, restrictionId: "r-rota" },
      ]),
    );
    expect(techos).toEqual([]);
  });
});
