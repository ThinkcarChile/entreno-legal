import { z } from "zod";

/**
 * Nombre e inicial que se muestran en el perfil público.
 *
 * La regla la impone la base (`app_private.person_name_problem` y
 * `app_private.is_valid_initial`, migración …001120) sobre cualquier camino de
 * escritura: el UPDATE directo, las funciones y la clave de servicio. Esta copia
 * existe para que el formulario diga qué está mal antes de enviar; si las dos
 * se separan, manda la base. Los mensajes son los mismos a propósito.
 *
 * El motivo de la regla: el nombre entra en el texto de los avisos que recibe la
 * contraparte. Un nombre con saltos de línea, una dirección web o «HagoTuFila»
 * se leía como un mensaje de la plataforma.
 */

/**
 * Controles C0 y C1, espacios no separables y de ancho fijo, guion suave,
 * marcas de dirección (pueden invertir el texto en pantalla) y caracteres de
 * ancho cero. Se arma desde texto para que el patrón se lea igual que en SQL.
 */
const INVISIBLE = new RegExp(
  "[\\u0001-\\u001f\\u007f-\\u009f\\u00a0\\u00ad\\u061c\\u180e\\u2000-\\u200f" +
    "\\u2028-\\u202f\\u205f-\\u206f\\u3000\\ufeff]",
  "u",
);
const WEB = /(:\/\/|www\.|@|[a-z0-9-]\.[a-z]{2,})/i;

/** Lo que no es una letra de ningún alfabeto, con la misma lista que la base. */
const NOT_A_LETTER = new RegExp(
  "[\\u0001-\\u0040\\u005b-\\u0060\\u007b-\\u00bf\\u00d7\\u00f7\\u2000-\\u206f" +
    "\\u3000-\\u303f\\ufeff]",
  "u",
);

/** `null` si el nombre sirve; si no, el motivo en palabras. */
export function personNameProblem(name: string): string | null {
  // La base cuenta caracteres, no unidades UTF-16.
  const length = [...name].length;
  if (length === 0) return "Ingresa tu nombre.";
  if (length > 60) return "El nombre admite hasta 60 caracteres.";
  if (INVISIBLE.test(name)) {
    return "El nombre no puede tener saltos de línea, tabulaciones ni caracteres invisibles.";
  }
  if (name !== name.replace(/^ +| +$/g, "") || name.includes("  ")) {
    return "El nombre no puede empezar ni terminar con espacios, ni tener espacios dobles.";
  }
  if (WEB.test(name)) return "El nombre no puede incluir direcciones web ni correos.";
  if (name.toLowerCase().includes("hagotufila")) return "El nombre no puede incluir «HagoTuFila».";
  return null;
}

/** Una letra, de cualquier alfabeto. Es lo que se guarda del apellido. */
export function isValidInitial(initial: string): boolean {
  return [...initial].length === 1 && !NOT_A_LETTER.test(initial);
}

/**
 * Lo mismo que hace `complete_onboarding` antes de validar: quita los espacios
 * del borde y colapsa los repetidos. No es un error que valga la pena devolver.
 */
export function normalizePersonName(name: string): string {
  return name.replace(/^ +| +$/g, "").replace(/ {2,}/g, " ");
}

export const personNameSchema = z
  .string()
  .transform(normalizePersonName)
  .superRefine((value, ctx) => {
    const problem = personNameProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export const lastNameSchema = z
  .string()
  .transform(normalizePersonName)
  .superRefine((value, ctx) => {
    if ([...value].length < 2) {
      ctx.addIssue({ code: "custom", message: "Ingresa tu apellido" });
    } else if ([...value].length > 60) {
      ctx.addIssue({ code: "custom", message: "El apellido admite hasta 60 caracteres." });
    } else if (!isValidInitial([...value][0])) {
      ctx.addIssue({ code: "custom", message: "El apellido debe comenzar con una letra." });
    }
  });
