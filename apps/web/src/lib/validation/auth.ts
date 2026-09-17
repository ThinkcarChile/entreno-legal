import { z } from "zod";

export const emailSchema = z.string().email("Ingresa un correo válido");

export const passwordSchema = z
  .string()
  .min(8, "La contraseña necesita al menos 8 caracteres")
  .max(72, "La contraseña es demasiado larga");

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Ingresa tu contraseña"),
});

export const signUpSchema = z
  .object({
    firstName: z.string().min(2, "Ingresa tu nombre").max(60),
    lastName: z.string().min(2, "Ingresa tu apellido").max(60),
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    intent: z.enum(["CLIENT", "WORKER"]),
    acceptsTerms: z.boolean().refine((v) => v, "Debes aceptar los términos"),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Las contraseñas no coinciden",
    path: ["confirmPassword"],
  });

export type SignInInput = z.infer<typeof signInSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;

/** Valida el dígito verificador de un RUT chileno. */
export function isValidRut(value: string): boolean {
  const clean = value.replace(/[.\-\s]/g, "").toUpperCase();
  if (clean.length < 2) return false;
  const body = clean.slice(0, -1);
  const checkDigit = clean.slice(-1);
  if (!/^\d+$/.test(body)) return false;

  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? "0" : remainder === 10 ? "K" : String(remainder);
  return expected === checkDigit;
}

export const rutSchema = z
  .string()
  .refine(isValidRut, "El RUT no es válido");
