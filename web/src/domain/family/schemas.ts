import { z } from "zod";

export const signInSchema = z.object({
  email: z.string().trim().email("Correo inválido"),
  password: z.string().min(8, "Mínimo 8 caracteres"),
});

export const createHouseholdSchema = z.object({
  householdName: z.string().trim().min(1, "Nombre requerido").max(120),
  displayName: z.string().trim().min(1, "Tu nombre es requerido").max(80),
});

export const inviteSchema = z.object({
  roleCode: z.enum(["ADMIN", "MEMBER", "PLANNER", "SHOPPER", "COOK"]).default("MEMBER"),
  email: z
    .union([z.string().trim().email("Correo inválido"), z.literal("")])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .default(null),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  displayName: z.string().trim().min(1).max(80).default("Integrante"),
});
