/**
 * EL ÚNICO VALIDADOR DE DESTINOS INTERNOS.
 *
 * Todo `?next=` que la aplicación consume —el login, el registro, el callback de
 * Auth, la recuperación de clave— pasa por acá y por ningún otro lado. Antes
 * vivía como `nextPath`, privado dentro de `login/actions.ts`, y decía:
 *
 *     value.startsWith("/") && !value.startsWith("//")
 *
 * Eso deja pasar `/\evil.com`. Empieza con una barra y no con dos, así que
 * cumple la regla — y los navegadores tratan la barra invertida como barra en
 * las URL http, así que `/\evil.com` es `//evil.com` con otra ortografía, y
 * `//evil.com` es un destino externo: `Location: //evil.com` sale del sitio.
 * Un login que redirige a donde diga la URL es una página de phishing con
 * nuestro dominio en la barra.
 *
 * Por eso esto no es una lista de prefijos prohibidos: es una lista de lo
 * ÚNICO que se acepta. Se decodifica hasta que ya no cambie (para atrapar lo
 * doblemente codificado), se rechaza cualquier barra invertida y cualquier
 * carácter de control, y lo que queda se resuelve contra un origen ficticio: si
 * el resultado no vive en ese origen, no es interno. Lo que se devuelve es la
 * ruta NORMALIZADA por el parser de URL, no el texto que llegó.
 *
 * Cuando algo no pasa, la respuesta es `porOmision` y nada más. No se avisa, no
 * se corrige: un destino que había que arreglar es un destino que alguien
 * escribió a mano para ver qué pasaba.
 */

const ORIGEN_FICTICIO = "http://interno.invalid";

/**
 * Rutas que nunca son un destino válido después de entrar: mandan de vuelta a
 * la puerta y arman un bucle (`/login?next=/login?next=…`). `/nueva-contrasena`
 * NO está acá a propósito: es el destino legítimo del enlace de recuperación.
 */
const NUNCA_DESTINO = /^\/(?:(?:login|recuperar)(?:\/|\?|$)|auth\/)/;

/**
 * Barra invertida en cualquier posicion, y caracteres de control (incluido el
 * DEL). Es un bucle y no un regex a proposito: la regla `no-control-regex` de
 * ESLint prohibe escribir los de control en un patron, y con razon — en un
 * patron nadie los ve. Aca cada codigo esta escrito con su numero.
 *
 * Los de control van ANTES del parser de URL: el parser descarta tabulaciones
 * y saltos de linea en silencio, y una tabulacion metida en `/evil` pasaria
 * como `/evil` sin que nadie la viera.
 */
function tieneProhibidos(texto: string): boolean {
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c /* barra invertida */) return true;
  }
  return false;
}

/**
 * Devuelve una ruta interna segura, o `porOmision` si `raw` no lo es.
 *
 * @param raw lo que llegó por `?next=`, un campo oculto o un parámetro de ruta.
 * @param porOmision a dónde ir cuando `raw` no sirve. Es un valor nuestro, no
 *   se valida: quien lo pasa es código, no una persona.
 */
export function destinoInterno(raw: unknown, porOmision = "/"): string {
  if (typeof raw !== "string") return porOmision;
  // Los caracteres de control se buscan en lo que LLEGÓ, antes de recortar:
  // `trim()` se come un salto de línea al final, y así `/evil.com` seguido de
  // un salto pasaba limpio. Recortar es sólo para los espacios que un
  // formulario agrega solo.
  if (tieneProhibidos(raw)) return porOmision;

  let valor = raw.replace(/^ +| +$/g, "");
  if (valor === "") return porOmision;

  // Decodificar hasta que se quede quieto. `%2F%2Fevil.com` es `//evil.com` con
  // un disfraz, y `%252F` es el mismo disfraz puesto dos veces. Tres vueltas
  // alcanzan para cualquier cosa que un navegador haya podido producir; si una
  // vuelta revienta (un `%` suelto), se sigue con lo que había, que igual se
  // valida más abajo.
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    let decodificado: string;
    try {
      decodificado = decodeURIComponent(valor);
    } catch {
      break;
    }
    if (decodificado === valor) break;
    valor = decodificado;
  }

  if (!valor.startsWith("/")) return porOmision;
  if (valor.startsWith("//")) return porOmision;
  if (tieneProhibidos(valor)) return porOmision;

  let url: URL;
  try {
    url = new URL(valor, ORIGEN_FICTICIO);
  } catch {
    return porOmision;
  }
  // Si el parser decidió que esto vive en otro lado, no es interno.
  if (url.origin !== ORIGEN_FICTICIO) return porOmision;
  if (url.pathname.startsWith("//")) return porOmision;
  if (NUNCA_DESTINO.test(url.pathname)) return porOmision;

  // Ruta y consulta, normalizadas. El fragmento (`#…`) se descarta: no viaja al
  // servidor y no hay para qué reenviarlo.
  return url.pathname + url.search;
}
