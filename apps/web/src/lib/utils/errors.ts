/**
 * Traducción de errores a lenguaje entendible.
 *
 * Nunca se muestra al usuario el texto crudo de PostgreSQL ni de Supabase: puede
 * filtrar nombres de tablas, columnas y restricciones, y además no le dice nada
 * a quien lo lee.
 */

export interface AppError {
  message: string;
  /** Campo del formulario al que apunta el problema, si aplica. */
  field?: string;
}

interface RawError {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
  status?: number;
}

const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: "El correo o la contraseña no coinciden.",
  email_not_confirmed: "Confirma tu correo antes de entrar. Revisa tu bandeja.",
  user_already_exists: "Ya existe una cuenta con ese correo.",
  weak_password: "La contraseña es demasiado débil. Usa al menos 8 caracteres.",
  over_email_send_rate_limit: "Enviamos demasiados correos. Espera unos minutos.",
  same_password: "La contraseña nueva debe ser distinta de la anterior.",
};

const PG_MESSAGES: Record<string, string> = {
  "23505": "Ese registro ya existe.",
  "23503": "Falta un dato relacionado o el valor no es válido.",
  "23514": "La operación no cumple una regla del servicio.",
  "42501": "No tienes permiso para hacer esto.",
  P0002: "No encontramos el registro.",
};

/**
 * Los mensajes que las funciones de la base lanzan con RAISE EXCEPTION están
 * escritos en español y pensados para el usuario final. Cuando vienen de ahí se
 * muestran tal cual; cualquier otro texto se reemplaza por uno genérico.
 */
function isCuratedMessage(message: string): boolean {
  if (!message) return false;
  if (/^[a-z_]+$/.test(message)) return false;
  // Señales de que el texto viene de PostgreSQL y no de una regla de negocio.
  const technical = [
    "relation",
    "column",
    "violates",
    "constraint",
    "syntax error",
    "permission denied",
    "duplicate key",
    "null value",
    "invalid input",
    "row-level security",
    "function",
    "type ",
  ];
  const lower = message.toLowerCase();
  return !technical.some((token) => lower.includes(token));
}

export function toAppError(error: unknown, fallback = "No pudimos completar la acción."): AppError {
  if (!error) return { message: fallback };

  const raw = error as RawError;
  const code = raw.code ?? "";

  if (AUTH_MESSAGES[code]) return { message: AUTH_MESSAGES[code] };
  if (PG_MESSAGES[code] && !isCuratedMessage(raw.message ?? "")) {
    return { message: PG_MESSAGES[code] };
  }

  if (raw.message && isCuratedMessage(raw.message)) {
    return { message: raw.message };
  }

  if (raw.status === 429) {
    return { message: "Demasiados intentos. Espera un momento y vuelve a intentarlo." };
  }

  return { message: fallback };
}

/** Resultado uniforme de las acciones de servidor. */
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; field?: string };

export function actionOk(): ActionResult<void>;
export function actionOk<T>(data: T): ActionResult<T>;
export function actionOk<T>(data?: T): ActionResult<T | undefined> {
  return { ok: true, data };
}

export function actionError(error: unknown, fallback?: string): ActionResult<never> {
  const { message, field } = toAppError(error, fallback);
  return { ok: false, error: message, field };
}
