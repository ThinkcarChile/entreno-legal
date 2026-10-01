import { describe, expect, it } from "vitest";

import {
  isValidInitial,
  lastNameSchema,
  normalizePersonName,
  personNameProblem,
  personNameSchema,
} from "./profile";

/**
 * La misma regla que `app_private.person_name_problem` en la base. Los casos
 * son los de `supabase/tests/14_public_data.sql` (U43–U57), para que las dos
 * copias no se separen en silencio.
 */
describe("personNameProblem", () => {
  it("acepta nombres con tildes, eñe y dos palabras", () => {
    expect(personNameProblem("José Ñandú")).toBeNull();
    expect(personNameProblem("María José")).toBeNull();
    expect(personNameProblem("O'Higgins")).toBeNull();
    expect(personNameProblem("Ma. José")).toBeNull();
  });

  it("rechaza saltos de línea, tabulaciones y caracteres invisibles", () => {
    expect(personNameProblem("Ernesto\nTu pago fue rechazado")).toMatch(/saltos de línea/);
    expect(personNameProblem("Ernesto\tPaz")).toMatch(/saltos de línea/);
    expect(personNameProblem("Ernesto\u202Eotsenre")).toMatch(/invisibles/);
    expect(personNameProblem("Ana\u200BMaría")).toMatch(/invisibles/);
    expect(personNameProblem("Ana\u00A0María")).toMatch(/invisibles/);
  });

  it("rechaza las comillas que delimitan el nombre en los avisos", () => {
    expect(personNameProblem("Soporte». Tu pago fue rechazado, llama al 229876543 «X")).toMatch(
      /comillas/,
    );
    expect(personNameProblem('Ana "la jefa"')).toMatch(/comillas/);
    expect(personNameProblem("Ana “Soporte”")).toMatch(/comillas/);
    expect(personNameProblem("Ana ‹X›")).toMatch(/comillas/);
  });

  it("rechaza direcciones web y correos", () => {
    expect(personNameProblem("Ernesto pagos-htf.cl")).toMatch(/direcciones web/);
    expect(personNameProblem("Ana www.pagos.cl")).toMatch(/direcciones web/);
    expect(personNameProblem("https://x")).toMatch(/direcciones web/);
    expect(personNameProblem("ana@correo")).toMatch(/direcciones web/);
  });

  it("rechaza hacerse pasar por la plataforma", () => {
    expect(personNameProblem("HagoTuFila: tu pago fue rechazado")).toMatch(/HagoTuFila/);
    expect(personNameProblem("Soporte hagotufila")).toMatch(/HagoTuFila/);
  });

  it("exige el nombre recortado, sin espacios dobles y de 1 a 60 caracteres", () => {
    expect(personNameProblem("")).toBe("Ingresa tu nombre.");
    expect(personNameProblem(" Ernesto")).toMatch(/espacios/);
    expect(personNameProblem("Ana  María")).toMatch(/espacios dobles/);
    expect(personNameProblem("a".repeat(60))).toBeNull();
    expect(personNameProblem("a".repeat(61))).toMatch(/60 caracteres/);
    // Se cuentan caracteres, como la base, no unidades UTF-16.
    expect(personNameProblem("𝒜".repeat(60))).toBeNull();
  });
});

describe("isValidInitial", () => {
  it("acepta una letra de cualquier alfabeto", () => {
    expect(isValidInitial("Á")).toBe(true);
    expect(isValidInitial("Ñ")).toBe(true);
    expect(isValidInitial("Ж")).toBe(true);
  });

  it("rechaza dígitos, signos, espacios y más de un carácter", () => {
    expect(isValidInitial("1")).toBe(false);
    expect(isValidInitial("'")).toBe(false);
    expect(isValidInitial(" ")).toBe(false);
    expect(isValidInitial("¿")).toBe(false);
    expect(isValidInitial("AB")).toBe(false);
    expect(isValidInitial("")).toBe(false);
  });
});

describe("esquemas del formulario", () => {
  it("normaliza espacios antes de validar, como complete_onboarding", () => {
    expect(normalizePersonName("  Ana   María ")).toBe("Ana María");
    expect(personNameSchema.parse("  Ana   María ")).toBe("Ana María");
  });

  it("devuelve el motivo de la base como mensaje", () => {
    const result = personNameSchema.safeParse("Ana www.pagos.cl");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "El nombre no puede incluir direcciones web ni correos.",
    );
  });

  it("exige que el apellido empiece con una letra", () => {
    expect(lastNameSchema.parse("Ñúñez")).toBe("Ñúñez");
    expect(lastNameSchema.safeParse("1Pérez").success).toBe(false);
    expect(lastNameSchema.safeParse("P").success).toBe(false);
  });
});
