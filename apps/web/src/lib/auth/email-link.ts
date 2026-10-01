import { safeNextPath } from "@/lib/utils/safe-redirect";

/**
 * Enlaces de los correos de Supabase Auth: confirmar la cuenta, crear una
 * contraseña nueva y confirmar un cambio de correo.
 *
 * Hay dos formas de que un enlace de correo termine en una sesión:
 *
 *  · `/auth/callback?code=…` (PKCE). Supabase verifica el enlace y devuelve un
 *    código que se canjea por la sesión con un verificador guardado en una
 *    cookie **del navegador donde se pidió el correo**. Abierto en otro
 *    navegador, en el visor de la app de correo o en el teléfono cuando se
 *    pidió desde el computador, el verificador no está y el canje falla. Antes
 *    fallaba en silencio: `/entrar?error=auth` no lo mostraba nadie.
 *  · `/auth/confirm?token_hash=…&type=…`. El enlace lleva todo lo necesario: el
 *    servidor lo verifica con `verifyOtp` y deja la sesión en el navegador que
 *    lo abre, sea cual sea.
 *
 * Cuál de las dos llega en el correo lo deciden las plantillas del panel de
 * Supabase, no este código: ver `docs/DESPLIEGUE-SUPABASE.md` §4.1.c. Las dos
 * rutas conviven para que los correos ya enviados sigan funcionando.
 *
 * Este módulo no toca la red ni la sesión: valida parámetros y decide destinos.
 * Por eso se puede probar sin Supabase.
 */

/**
 * Tipos de enlace que acepta `/auth/confirm`, y adónde lleva cada uno.
 *
 * `email` es el que recomienda hoy Supabase para confirmar la cuenta (y para
 * el enlace mágico); `signup` y `magiclink` son sus nombres anteriores, que
 * `verifyOtp` sigue aceptando. `invite` no está: la aplicación no invita a
 * nadie, y un enlace de invitación deja una sesión sin contraseña.
 */
const DESTINOS = {
  email: "/bienvenida",
  signup: "/bienvenida",
  magiclink: "/bienvenida",
  recovery: "/nueva-clave",
  email_change: "/cuenta",
} as const;

export type ConfirmLinkType = keyof typeof DESTINOS;

export const CONFIRM_LINK_TYPES = Object.keys(DESTINOS) as readonly ConfirmLinkType[];

/**
 * El `token_hash` de Supabase es un resumen hexadecimal (con prefijo `pkce_`
 * cuando el proyecto usa PKCE). Se acepta ese alfabeto y un largo razonable:
 * lo que no encaje no es un enlace de Supabase, y no se reenvía a Auth.
 */
const TOKEN_HASH = /^[A-Za-z0-9_-]{16,256}$/;

export type ConfirmLink =
  | { ok: true; tokenHash: string; type: ConfirmLinkType; next: string }
  | { ok: false; type: ConfirmLinkType | null };

function isConfirmLinkType(value: string | null): value is ConfirmLinkType {
  return value !== null && Object.prototype.hasOwnProperty.call(DESTINOS, value);
}

/**
 * Lee y valida los parámetros de `/auth/confirm`.
 *
 * `next` pasa por `safeNextPath`: lo controla quien arma el enlace. La
 * recuperación de contraseña ignora `next` y va siempre a `/nueva-clave`: una
 * sesión de recuperación que aterriza en otra página deja a la persona dentro
 * de su cuenta sin haber cambiado la contraseña que había olvidado.
 */
export function parseConfirmLink(params: URLSearchParams): ConfirmLink {
  const rawType = params.get("type");
  const type = isConfirmLinkType(rawType) ? rawType : null;
  const tokenHash = params.get("token_hash")?.trim() ?? "";

  if (!type || !TOKEN_HASH.test(tokenHash)) return { ok: false, type };

  const next = type === "recovery" ? DESTINOS.recovery : safeNextPath(params.get("next"), DESTINOS[type]);
  return { ok: true, tokenHash, type, next };
}

/* ------------------------------------------------------------- errores */

/**
 * Por qué un enlace no abrió sesión, en el vocabulario de la pantalla que lo
 * explica. Viaja en `?error=` y nunca lleva el texto de Supabase.
 */
export type AuthLinkError = "enlace-vencido" | "enlace-invalido" | "otro-navegador" | "auth";

/**
 * Clasifica el código de error de Supabase Auth (`error.code`, o el
 * `error_code` que Supabase agrega a la URL de retorno).
 */
export function classifyAuthLinkError(code: string | null | undefined): AuthLinkError {
  switch (code) {
    case "otp_expired":
    case "flow_state_expired":
      return "enlace-vencido";
    case "pkce_code_verifier_not_found":
    case "bad_code_verifier":
    case "flow_state_not_found":
      return "otro-navegador";
    case undefined:
    case null:
    case "":
      return "auth";
    default:
      return "enlace-invalido";
  }
}

/**
 * Adónde mandar a alguien cuyo enlace no sirvió.
 *
 * Un enlace de contraseña nueva vuelve a `/recuperar-clave`, donde puede pedir
 * otro en el mismo paso; el resto, a `/entrar`.
 */
export function authLinkErrorPath(type: ConfirmLinkType | "recovery" | null, error: AuthLinkError): string {
  const base = type === "recovery" ? "/recuperar-clave" : "/entrar";
  return `${base}?error=${error}`;
}

export interface AuthLinkMessage {
  title: string;
  body: string;
}

const MENSAJES: Record<"entrar" | "recuperar", Record<AuthLinkError, AuthLinkMessage>> = {
  entrar: {
    "enlace-vencido": {
      title: "El enlace ya no es válido",
      body:
        "Venció o ya se usó: cada enlace sirve una sola vez. Si ya confirmaste tu correo, " +
        "entra con tu correo y tu contraseña.",
    },
    "enlace-invalido": {
      title: "No pudimos abrir el enlace",
      body:
        "Llegó incompleto o no corresponde a una cuenta de HagoTuFila. Ábrelo de nuevo desde el " +
        "correo, copiándolo entero, o entra con tu correo y tu contraseña.",
    },
    "otro-navegador": {
      title: "El enlace se abrió en otro navegador",
      body:
        "Lo abriste en un navegador distinto del que usaste para registrarte. Es probable que tu " +
        "correo ya haya quedado confirmado: prueba entrar con tu correo y tu contraseña.",
    },
    auth: {
      title: "No pudimos validar el enlace",
      body: "Prueba entrar con tu correo y tu contraseña. Si no puedes, escríbenos.",
    },
  },
  recuperar: {
    "enlace-vencido": {
      title: "El enlace para cambiar tu contraseña venció",
      body: "Cada enlace sirve una sola vez y por tiempo limitado. Pide uno nuevo aquí abajo.",
    },
    "enlace-invalido": {
      title: "No pudimos abrir el enlace",
      body: "Llegó incompleto o no es válido. Pide uno nuevo aquí abajo.",
    },
    // El enlace ya quedó usado: Supabase lo consume al verificarlo, antes de
    // que falle el canje en este navegador. Volver a abrirlo en el otro no
    // serviría; lo único que funciona es pedir uno nuevo.
    "otro-navegador": {
      title: "El enlace se abrió en otro navegador",
      body:
        "Lo abriste en un navegador distinto del que usaste para pedirlo, y ya no sirve: cada " +
        "enlace se usa una sola vez. Pide uno nuevo aquí abajo y ábrelo en este mismo navegador.",
    },
    auth: {
      title: "No pudimos validar el enlace",
      body: "Pide uno nuevo aquí abajo.",
    },
  },
};

/**
 * El aviso que corresponde a un `?error=` de la URL, o `null` si el valor no es
 * uno de los nuestros. Un valor desconocido no se muestra: la URL la puede
 * escribir cualquiera.
 */
export function authLinkMessage(
  code: string | null | undefined,
  screen: "entrar" | "recuperar",
): AuthLinkMessage | null {
  if (!code) return null;
  const table = MENSAJES[screen];
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code as AuthLinkError] : null;
}
