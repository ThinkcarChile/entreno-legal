import { describe, expect, it } from "vitest";

import { newPasswordSchema, passwordSchema, PASSWORD_MIN_LENGTH, signUpSchema } from "./auth";

const registro = {
  firstName: "Camila",
  lastName: "Rojas",
  email: "camila@example.cl",
  password: "ocho1234",
  confirmPassword: "ocho1234",
  intent: "CLIENT" as const,
  acceptsTerms: true,
};

describe("mínimo de contraseña", () => {
  it("es 8, por encima de los 6 que trae Supabase", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
  });

  it("rechaza 7 caracteres y acepta 8", () => {
    expect(passwordSchema.safeParse("siete77").success).toBe(false);
    expect(passwordSchema.safeParse("ocho1234").success).toBe(true);
  });

  it("explica el mínimo en español", () => {
    const result = passwordSchema.safeParse("corta");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe("La contraseña necesita al menos 8 caracteres");
  });

  it("rechaza más de 72, el límite de bcrypt", () => {
    expect(passwordSchema.safeParse("x".repeat(72)).success).toBe(true);
    expect(passwordSchema.safeParse("x".repeat(73)).success).toBe(false);
  });

  it("el registro aplica el mismo mínimo", () => {
    expect(signUpSchema.safeParse(registro).success).toBe(true);
    const corta = signUpSchema.safeParse({ ...registro, password: "seis66", confirmPassword: "seis66" });
    expect(corta.success).toBe(false);
    expect(corta.error?.issues[0].path).toEqual(["password"]);
  });

  it("la contraseña nueva tras recuperar aplica el mismo mínimo y exige repetirla igual", () => {
    expect(newPasswordSchema.safeParse({ password: "ocho1234", confirmPassword: "ocho1234" }).success).toBe(
      true,
    );
    const corta = newPasswordSchema.safeParse({ password: "seis66", confirmPassword: "seis66" });
    expect(corta.error?.issues[0].path).toEqual(["password"]);
    const distinta = newPasswordSchema.safeParse({ password: "ocho1234", confirmPassword: "ocho12345" });
    expect(distinta.error?.issues[0]).toMatchObject({
      path: ["confirmPassword"],
      message: "Las contraseñas no coinciden",
    });
  });
});
