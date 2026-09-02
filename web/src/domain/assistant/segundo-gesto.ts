/**
 * EL SEGUNDO GESTO: LA COMPARACIÓN, Y NADA MÁS.
 *
 * Este archivo existe por una razón de frontera, no de gusto. La comparación la
 * necesitan los DOS lados:
 *
 *  · el SERVIDOR, dentro de `ConfirmationGrant.reclamar`, donde es el control;
 *  · la TARJETA, que es "use client", donde es una cortesía —avisar sin red
 *    cuando el número no calza, para no gastar el viaje ni la confirmación viva.
 *
 * Escribirla dos veces sería la trampa de las dos compuertas en chico: la que
 * corre termina siendo la más floja. Así que hay UNA, y vive acá y no en
 * `proposal.ts`, porque `proposal.ts` importa `node:crypto` en su primera línea
 * y un módulo que llega al bundle del navegador arrastrando `node:crypto` no
 * compila. Este archivo no importa nada: es aritmética y una expresión regular.
 *
 * La compuerta de verdad —quién exige qué, y contra qué se contrasta— sigue
 * entera en `proposal.ts`. Acá solo está el "¿este número es ese número?".
 */

export type VeredictoSegundoGesto =
  | { ok: true }
  | { ok: false; motivo: "VACIO" | "NO_ES_NUMERO" | "NO_CALZA" };

/**
 * Compara lo que la persona escribió contra la cantidad de la propuesta.
 *
 * La firma es la defensa: devuelve un veredicto y NUNCA el número parseado, así
 * que no hay forma de que lo tecleado alimente la acción. Si alimentara,
 * teclear 8 donde la tarjeta dice 1,8 kg descartaría 8 kg — la persona habría
 * ejecutado algo que nadie revalidó y que la tarjeta no mostró.
 *
 * Acepta la coma decimal porque en Chile se escribe con coma, y compara con
 * tolerancia cero: "casi igual" no es igual cuando lo que sigue es botar
 * comida.
 */
export function comparaSegundoGesto(
  escrito: string,
  esperado: { readonly valor: number; readonly unidad: string },
): VeredictoSegundoGesto {
  const limpio = escrito.trim().replace(/\s/gu, "");
  if (limpio.length === 0) return { ok: false, motivo: "VACIO" };
  if (!/^\d+(?:[.,]\d+)?$/u.test(limpio)) return { ok: false, motivo: "NO_ES_NUMERO" };
  const valor = Number(limpio.replace(",", "."));
  if (!Number.isFinite(valor)) return { ok: false, motivo: "NO_ES_NUMERO" };
  return valor === esperado.valor ? { ok: true } : { ok: false, motivo: "NO_CALZA" };
}
