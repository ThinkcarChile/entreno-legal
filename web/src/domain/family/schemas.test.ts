import { describe, expect, it } from "vitest";
import { createHouseholdSchema, inviteSchema, signInSchema } from "./schemas";

describe("schemas", () => {
  it("signIn exige correo válido y contraseña de 8+", () => {
    expect(signInSchema.safeParse({ email: "a@b.cl", password: "12345678" }).success).toBe(true);
    expect(signInSchema.safeParse({ email: "no-es-correo", password: "12345678" }).success).toBe(false);
    expect(signInSchema.safeParse({ email: "a@b.cl", password: "corta" }).success).toBe(false);
  });

  it("createHousehold recorta espacios y exige nombres", () => {
    const ok = createHouseholdSchema.safeParse({ householdName: " Familia X ", displayName: "Paula" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.householdName).toBe("Familia X");
    expect(createHouseholdSchema.safeParse({ householdName: "  ", displayName: "Paula" }).success).toBe(false);
  });

  it("invite acepta correo vacío como null y valida rol", () => {
    const ok = inviteSchema.safeParse({ roleCode: "MEMBER", email: "" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.email).toBeNull();
    expect(inviteSchema.safeParse({ roleCode: "SUPREMO", email: "" }).success).toBe(false);
  });
});
