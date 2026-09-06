/**
 * LOS AVISOS DE LA PUERTA, POR CÓDIGO Y NO POR TEXTO.
 *
 * Antes el login mostraba lo que dijera `?error=`: cualquiera podía armar
 * `/login?error=Tu cuenta fue bloqueada, llama al 600…` y mandárselo a la
 * familia con nuestro dominio en la barra. Y el registro pasaba el mensaje crudo
 * de GoTrue —en inglés, y diciendo "User already registered"—, que es un
 * oráculo de qué correos existen.
 *
 * Ahora por la URL viaja un CÓDIGO de esta lista y el texto lo pone la página.
 * Un código desconocido no muestra nada. Y los mensajes que podrían revelar si
 * un correo existe son UNIFORMES a propósito: el que entra mal la clave y el que
 * todavía no confirmó el correo leen lo mismo, y el que pide recuperar una
 * cuenta que no existe lee lo mismo que el que sí la tiene.
 */

export const AVISOS = {
  credenciales: {
    tono: "error",
    texto:
      "No pudimos entrar. Revisa tu correo y tu clave; si acabas de crear la cuenta, confirma primero tu correo.",
  },
  datos: {
    tono: "error",
    texto: "Revisa los datos: un correo válido y una clave de al menos 8 caracteres.",
  },
  cuenta: {
    tono: "error",
    texto: "No pudimos crear la cuenta. Si ya tienes una, entra con tu clave o recupérala.",
  },
  "revisa-correo": {
    tono: "info",
    texto: "Te mandamos un enlace a tu correo. Ábrelo para confirmar tu cuenta y seguir.",
  },
  "enlace-invalido": {
    tono: "error",
    texto: "Ese enlace no sirve: puede estar vencido o ya se usó. Pide uno nuevo.",
  },
  "correo-enviado": {
    tono: "info",
    texto: "Si ese correo tiene una cuenta, le mandamos un enlace para cambiar la clave.",
  },
  "recuperacion-invalida": {
    tono: "error",
    texto:
      "El enlace de recuperación no sirve o venció. Pide uno nuevo desde «Olvidé mi contraseña».",
  },
  "clave-rechazada": {
    tono: "error",
    texto: "No pudimos guardar esa clave. Prueba con otra de al menos 8 caracteres.",
  },
  "clave-actualizada": {
    tono: "info",
    texto: "Tu clave quedó actualizada. Entra con la nueva.",
  },
} as const satisfies Record<string, { tono: "error" | "info"; texto: string }>;

export type Aviso = keyof typeof AVISOS;

/** El aviso que corresponde a un código, o `null` si el código no es nuestro. */
export function avisoDe(codigo: unknown): { tono: "error" | "info"; texto: string } | null {
  if (typeof codigo !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(AVISOS, codigo)) return null;
  return AVISOS[codigo as Aviso];
}

/** La ruta del login con un aviso puesto. Un solo lugar arma esa URL. */
export function alLogin(aviso: Aviso): string {
  return `/login?aviso=${aviso}`;
}
