import { z } from "zod";

import { lastNameSchema, personNameSchema } from "./profile";

export const emailSchema = z.string().email("Ingresa un correo válido");

/**
 * Mínimo de la aplicación para toda contraseña nueva: al registrarse y al
 * cambiarla.
 *
 * Es una barrera de los formularios y de las acciones de servidor, no de
 * Supabase: la API de Auth es pública y acepta lo que diga su propia
 * configuración (6 caracteres si nadie la cambió). Para que 8 sea el mínimo de
 * verdad hay que fijarlo también en el proyecto, ver
 * `docs/DESPLIEGUE-SUPABASE.md` §4.1.b. El máximo de 72 es el de bcrypt.
 */
export const PASSWORD_MIN_LENGTH = 8;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `La contraseña necesita al menos ${PASSWORD_MIN_LENGTH} caracteres`)
  .max(72, "La contraseña es demasiado larga");

/** Contraseña nueva tras un enlace de recuperación: la misma regla que al registrarse. */
export const newPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Las contraseñas no coinciden",
    path: ["confirmPassword"],
  });

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Ingresa tu contraseña"),
});

/**
 * El registro aplica la MISMA regla de nombre que la base (`personNameSchema`,
 * espejo de `app_private.person_name_problem`). Antes solo pedía 2 a 60
 * caracteres: un nombre como «Ana.Maria» —parece una dirección web— pasaba el
 * formulario, `handle_new_user` no podía guardarlo y lo cambiaba en silencio
 * por «Usuario», que después aparecía en el onboarding. Ahora el formulario lo
 * dice antes de enviar. El mínimo de 2 caracteres es del formulario.
 */
export const signUpSchema = z
  .object({
    firstName: personNameSchema.refine((v) => [...v].length >= 2, "Ingresa tu nombre"),
    lastName: lastNameSchema,
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
