/**
 * Saneado de todo lo que sale del SDK antes de tocar un registro, una fila o
 * una pantalla.
 *
 * Esto no es celo decorativo. El SDK oficial construye sus errores así:
 *
 *     new TransbankError(error, msg)   →   super(`${title}\n${message}\n`)
 *
 * donde `title` es el error de axios **entero**. Un error de axios lleva
 * `config.headers`, y ahí viaja `Tbk-Api-Key-Secret`. Basta con que alguien
 * haga `JSON.stringify(error)`, `console.error(error)` sobre la causa, o que un
 * marco de trabajo serialice el error en una página de fallo, para publicar la
 * clave secreta del comercio.
 *
 * Por eso ninguna excepción del SDK se propaga tal cual: se convierte en un
 * error propio con un mensaje corto, y cualquier texto que salga de aquí pasa
 * por `scrub`, que borra credenciales y tokens aunque se hayan colado por una
 * vía que no habíamos previsto.
 */

/** Claves cuyo valor nunca se conserva, venga como venga. */
const FORBIDDEN_KEYS = [
  "tbk-api-key-secret",
  "tbk-api-key-id",
  "authorization",
  "apikey",
  "api_key",
  "apikeysecret",
  "api_key_secret",
  "commercecode",
  "commerce_code",
  "secret",
  "password",
  "cookie",
  "set-cookie",
  "headers",
  "config",
  "request",
  "cvv",
  "card_number_full",
];

/** Campos que sí se conservan de una transacción, y ninguno más. */
const ALLOWED_TRANSACTION_KEYS = [
  "vci",
  "amount",
  "status",
  "buy_order",
  "session_id",
  "accounting_date",
  "transaction_date",
  "authorization_code",
  "payment_type_code",
  "response_code",
  "installments_amount",
  "installments_number",
  "balance",
  "type",
  "authorization_date",
  "nullified_amount",
];

/**
 * Enmascara un token: los seis primeros y los cuatro últimos.
 *
 * Un token de Webpay autoriza a confirmar una transacción. En un registro sirve
 * para reconocerlo, no para usarlo, así que nunca se escribe entero.
 */
export function maskToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const value = String(token);
  if (value.length <= 12) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * Borra de un texto cualquier credencial o token conocido.
 *
 * Recibe los secretos vigentes porque son los únicos que se pueden buscar
 * literalmente. El resto —cadenas largas de hexadecimal— se enmascara por
 * forma: una tira de 60 o más caracteres hexadecimales en un mensaje de error
 * no es nunca algo que se deba conservar.
 */
export function scrub(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      out = out.split(secret).join("«oculto»");
    }
  }
  // Cadenas largas de hexadecimal o base64: tokens y claves.
  out = out.replace(/\b[A-Fa-f0-9]{40,}\b/g, "«oculto»");
  out = out.replace(/\b[A-Za-z0-9_-]{60,}\b/g, "«oculto»");
  // Cabeceras, por si el SDK las hubiese interpolado en el mensaje.
  out = out.replace(/(Tbk-Api-Key-[A-Za-z]+\s*:\s*)\S+/gi, "$1«oculto»");
  return out;
}

/**
 * Deja de un objeto del proveedor solo los campos de la lista permitida.
 *
 * Es una lista blanca y no una negra a propósito: una lista negra deja pasar
 * lo que aún no conocemos, y esto se guarda en la base para auditoría.
 * `card_detail` se trata aparte porque contiene los cuatro últimos dígitos, que
 * sí se conservan, dentro de un objeto que no.
 */
export function sanitizeProviderPayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object") return {};
  const source = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of ALLOWED_TRANSACTION_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "object") continue;
    out[key] = value;
  }

  const cardDetail = source.card_detail;
  if (cardDetail && typeof cardDetail === "object") {
    const digits = String((cardDetail as Record<string, unknown>).card_number ?? "").replace(
      /\D/g,
      "",
    );
    if (digits.length > 0) out.card_last_digits = digits.slice(-4);
  }

  return out;
}

/** ¿Este objeto contiene todavía algo que no debería guardarse? */
export function containsForbiddenKeys(payload: unknown, depth = 0): boolean {
  if (depth > 6 || payload === null || typeof payload !== "object") return false;
  if (Array.isArray(payload)) return payload.some((item) => containsForbiddenKeys(item, depth + 1));
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) return true;
    if (containsForbiddenKeys(value, depth + 1)) return true;
  }
  return false;
}
