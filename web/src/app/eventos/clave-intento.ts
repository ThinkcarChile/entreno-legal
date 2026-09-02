/**
 * LA CLAVE DE UN INTENTO DE ESCRITURA — NO DEL CONTENIDO.
 *
 * El día del asado se aprieta el botón dos veces: hay humo, hay ruido y la
 * pantalla tarda. Para que el segundo apretón no saque otros 1,2 kg de la
 * despensa, la pantalla manda una clave y el servidor la reconoce.
 *
 * LO QUE ESTA CLAVE NO PUEDE SER, y es el defecto que vino a cerrar: un resumen
 * de lo que se está guardando. Con una clave derivada del contenido ("mismo
 * corte + misma cantidad + mismo día"), la SEGUNDA fuente de 800 g que sale de
 * verdad a la mesa no descuenta nada y el segundo táper de 800 g nunca entra al
 * inventario — y la pantalla igual dice "guardado". Dos actos parecidos son dos
 * actos. Por eso la clave es aleatoria, se genera UNA vez por intento y se
 * suelta recién cuando el servidor confirmó: un reintento del mismo apretón la
 * repite, un acto nuevo trae una nueva.
 *
 * Y SI EL NAVEGADOR NO TIENE DE DÓNDE SACAR ALEATORIEDAD, devuelve `null`: sin
 * clave el servidor escribe cada llamada, que es exactamente lo que hay que
 * hacer cuando no se puede distinguir un reintento de un acto nuevo. Inventar
 * una clave débil sería volver a colapsar hechos reales, con peor disfraz.
 */

/** Lo mínimo de `crypto` que hace falta acá. */
export interface FuenteAleatoria {
  randomUUID?: () => string;
  getRandomValues?: (arreglo: Uint8Array) => Uint8Array;
}

export function nuevaClaveDeIntento(fuente: FuenteAleatoria | undefined): string | null {
  if (fuente === undefined || fuente === null) return null;

  if (typeof fuente.randomUUID === "function") return fuente.randomUUID();

  if (typeof fuente.getRandomValues === "function") {
    const bytes = fuente.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  return null;
}
