/**
 * LOS AVISOS DE LA PANTALLA DE FAMILIA, POR CÓDIGO Y NO POR TEXTO.
 *
 * Mismo motivo que `lib/auth/avisos.ts`: `/family?error=<texto>` pintaba lo que
 * dijera la URL, y `destinoInterno` deja encadenar `/login?next=/family?error=…`.
 * El resultado es texto de estafa dentro de una caja roja, con nuestro dominio
 * en la barra, visible a alguien que ya tiene sesión — más creíble, no menos.
 * React escapa el HTML, así que no es XSS; es content spoofing, y se cierra
 * igual: por la URL viaja un CÓDIGO de esta lista y el texto lo pone la página.
 *
 * Un código desconocido no muestra nada. Las acciones de familia e invitación
 * redirigen con estos códigos; ninguna vuelve a poner texto libre en la URL.
 */

export const AVISOS_FAMILIA = {
  "datos-hogar": "Revisa los datos del hogar: un nombre y tu nombre.",
  "hogares-cerrados":
    "Los hogares nuevos están cerrados. Para entrar necesitas una invitación de tu familia.",
  "no-se-creo": "No se pudo crear el hogar. Intenta de nuevo.",
  "datos-invitacion": "Revisa los datos de la invitación.",
  "solo-admin": "Solo el administrador del hogar puede invitar.",
  "invitacion-invalida": "La invitación no sirve: puede estar vencida o ya haberse usado.",
} as const;

export type AvisoFamilia = keyof typeof AVISOS_FAMILIA;

/** El texto de un código, o `null` si el código no es nuestro. */
export function avisoFamiliaDe(codigo: unknown): string | null {
  if (typeof codigo !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(AVISOS_FAMILIA, codigo)) return null;
  return AVISOS_FAMILIA[codigo as AvisoFamilia];
}

/** `/family` con un aviso puesto. Un solo lugar arma esa URL. */
export function alFamily(aviso: AvisoFamilia): string {
  return `/family?aviso=${aviso}`;
}
