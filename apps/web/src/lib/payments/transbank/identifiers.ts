import { randomBytes } from "node:crypto";

/**
 * Identificadores que viajan a Webpay: `buy_order` y `session_id`.
 *
 * Los dos vuelven del navegador del cliente en tres de los cuatro flujos de
 * retorno, así que son lo único que permite reencontrar el intento interno
 * cuando NO llega token. Por eso se construyen aquí y en ningún otro sitio, y
 * por eso se pueden leer al revés: de un `buy_order` se saca el pago.
 *
 * Límites reales del SDK (`ApiConstants`, no de memoria):
 *   buy_order  ≤ 26   session_id ≤ 61   return_url ≤ 255   token ≤ 64
 */
export const BUY_ORDER_MAX = 26;
export const SESSION_ID_MAX = 61;
export const RETURN_URL_MAX = 255;
export const TOKEN_MAX = 64;

/**
 * Solo mayúsculas, dígitos y guion.
 *
 * Sin acentos, sin espacios y sin nada que se parezca a un dato personal: el
 * `buy_order` aparece en el portal de Transbank, en la cartola del banco y en
 * los correos de conciliación.
 */
const BUY_ORDER_PATTERN = /^[A-Z0-9-]{1,26}$/;
const PREFIX = "HTF";

/** Los 12 primeros dígitos hexadecimales del UUID del pago, en mayúsculas. */
function paymentFingerprint(paymentId: string): string {
  const hex = paymentId.replace(/-/g, "").toUpperCase();
  if (hex.length < 12 || !/^[0-9A-F]+$/.test(hex)) {
    throw new Error(`Identificador de pago no válido para un buy_order: ${paymentId}`);
  }
  return hex.slice(0, 12);
}

/** Sufijo aleatorio en base32 sin vocales: no se confunde 0 con O ni 1 con I. */
const ALPHABET = "23456789BCDFGHJKLMNPQRSTVWXZ";

/**
 * Longitud del sufijo aleatorio.
 *
 * Nueve caracteres sobre un alfabeto de 28 son unas 10^13 combinaciones. Con
 * seis eran 4,8·10^8, y ahí el cumpleaños muerde: en 10.000 órdenes del mismo
 * pago la probabilidad de choque rondaba el 10 %, y lo encontró el verificador
 * a la primera. Un choque no es un detalle estético: `buy_order` tiene índice
 * único, así que sería un pago que no se puede iniciar.
 *
 * Con nueve, el `buy_order` mide exactamente 26 caracteres, que es el máximo
 * que admite Webpay (`ApiConstants.BUY_ORDER_LENGTH`).
 */
const NONCE_LENGTH = 9;

function nonce(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/**
 * `HTF-<12 hex del pago>-<6 aleatorios>` = 23 caracteres.
 *
 * Tres propiedades que hacen falta a la vez:
 *
 * · **Trazable**: la huella identifica el pago interno sin consultarlo. Un
 *   `buy_order` en un correo de Transbank se resuelve con un `like`.
 * · **Único aunque se reintente**: cada intento nuevo lleva otro sufijo. Webpay
 *   rechaza reutilizar un `buy_order` de una transacción viva, y reintentar
 *   tiene que poder ocurrir.
 * · **No depende del reloj**: dos intentos en el mismo milisegundo no colisionan,
 *   y nadie puede adivinar el siguiente contando segundos.
 */
export function buildBuyOrder(paymentId: string): string {
  const order = `${PREFIX}-${paymentFingerprint(paymentId)}-${nonce(NONCE_LENGTH)}`;
  if (!isValidBuyOrder(order)) {
    throw new Error("El buy_order generado no cumple el formato exigido");
  }
  return order;
}

export function isValidBuyOrder(value: string): boolean {
  return value.length <= BUY_ORDER_MAX && BUY_ORDER_PATTERN.test(value);
}

/** La huella del pago que lleva dentro un `buy_order`, o `null` si no es nuestro. */
export function paymentFingerprintOf(buyOrder: string): string | null {
  const match = /^HTF-([0-9A-F]{12})-[A-Z0-9]{9}$/.exec(buyOrder.trim().toUpperCase());
  return match ? match[1] : null;
}

/**
 * `session_id`: el UUID del pago sin guiones, con prefijo. 34 caracteres.
 *
 * No lleva correo, RUT, teléfono ni nombre, y no es la sesión de Supabase: es
 * un identificador interno del intento, que es exactamente lo que hace falta
 * para reencontrarlo cuando Webpay devuelve `TBK_ID_SESION` sin token. No es un
 * secreto ni autoriza nada: quien vuelve sigue teniendo que ser el dueño del
 * pago para que la ruta de retorno haga algo.
 */
export function buildSessionId(paymentId: string): string {
  const id = `S-${paymentId.replace(/-/g, "").toUpperCase()}`;
  if (id.length > SESSION_ID_MAX) {
    throw new Error("El session_id generado supera el límite de Webpay");
  }
  return id;
}

/** El UUID del pago que lleva dentro un `session_id`, o `null`. */
export function paymentIdFromSessionId(sessionId: string): string | null {
  const match = /^S-([0-9a-fA-F]{32})$/.exec(sessionId.trim());
  if (!match) return null;
  const hex = match[1].toLowerCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
