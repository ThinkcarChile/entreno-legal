import { describe, expect, it } from "vitest";

import {
  cancellationReasonProblem,
  freeTextProblem,
  jobTitleProblem,
  normalizeFreeText,
} from "./free-text";
import { stepDescriptionSchema } from "./job";

/**
 * Misma regla que `app_private.free_text_problem` (migración …001810). Los
 * casos que la base rechaza están en supabase/tests/21_app_security.sql
 * (G20–G27); aquí, los mismos desde el formulario.
 */
describe("título del trabajo", () => {
  it("acepta un título normal, con apóstrofo, tildes y números", () => {
    for (const title of [
      "Fila en el Registro Civil de Providencia",
      "Trámite en la notaría de O'Higgins, 9.30 h",
      "Retirar licencia en la Municipalidad de Ñuñoa",
    ]) {
      expect({ title, problem: jobTitleProblem(title) }).toEqual({ title, problem: null });
    }
  });

  it("rechaza lo que cierra la cita o suplanta a la plataforma", () => {
    expect(jobTitleProblem('Fila". HagoTuFila: verifica tu cuenta "OK')).toBe(
      "El título no puede incluir comillas.",
    );
    expect(jobTitleProblem("Fila urgente, paga en htf-pagos.cl")).toBe(
      "El título no puede incluir direcciones web ni correos.",
    );
    expect(jobTitleProblem("Fila para el equipo HagoTuFila")).toBe(
      "El título no puede incluir «HagoTuFila».",
    );
    expect(jobTitleProblem("Fila en notaría\u202eatrás")).toBe(
      "El título no puede tener saltos de línea, tabulaciones ni caracteres invisibles.",
    );
    expect(jobTitleProblem("Corto")).toBe("El título necesita al menos 10 caracteres");
    expect(jobTitleProblem("x".repeat(121))).toBe("El título admite hasta 120 caracteres.");
  });

  it("el asistente de publicación usa la misma regla", () => {
    const base = { description: "Una descripción suficientemente larga para pasar.", imageUrls: [] };
    expect(stepDescriptionSchema.safeParse({ ...base, title: "Fila en la notaría del centro" }).success).toBe(
      true,
    );
    const malo = stepDescriptionSchema.safeParse({ ...base, title: 'Fila "urgente" en notaría' });
    expect(malo.success).toBe(false);
    expect(malo.error?.issues[0].message).toBe("El título no puede incluir comillas.");
  });
});

describe("motivo de cancelación", () => {
  it("los saltos de línea y espacios repetidos se corrigen solos", () => {
    expect(normalizeFreeText("  Cambié\nde   planes\r\n ")).toBe("Cambié de planes");
    expect(cancellationReasonProblem(normalizeFreeText("Cambié\nde planes"))).toBeNull();
  });

  it("rechaza direcciones, comillas, «HagoTuFila» y lo que pasa de 300", () => {
    expect(cancellationReasonProblem("Equipo HagoTuFila: cuenta suspendida")).toBe(
      "El motivo no puede incluir «HagoTuFila».",
    );
    expect(cancellationReasonProblem("Reactívala en https://htf-soporte.cl")).toBe(
      "El motivo no puede incluir direcciones web ni correos.",
    );
    expect(cancellationReasonProblem("x".repeat(301))).toBe("El motivo admite hasta 300 caracteres.");
    expect(freeTextProblem("x".repeat(300), "El motivo", 300)).toBeNull();
  });
});
