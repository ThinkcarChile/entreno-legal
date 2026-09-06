import { describe, expect, it } from "vitest";
import { destinoInterno } from "./destino";

/**
 * EL GUARDIÁN DEL DESTINO, PROBADO POR LAS DOS PUNTAS.
 *
 * La mitad de estos casos son ataques y la otra mitad son rutas normales. Las
 * dos mitades importan igual: un validador que rechaza `/eventos?id=123` es tan
 * inútil como uno que acepta `//evil.com`, porque alguien lo va a "arreglar"
 * aflojándolo.
 *
 * Los casos de ataque vienen de un hueco real: `nextPath` aceptaba `/\evil.com`
 * porque empezaba con una barra y no con dos. Se comprobó por mutación que
 * volver a esa regla pone rojo este archivo (ver el informe de cierre).
 */

const ATAQUES: [string, string][] = [
  ["absoluta https", "https://evil.com"],
  ["absoluta http", "http://evil.com"],
  ["doble barra", "//evil.com"],
  ["barra y barra invertida", "/\\evil.com"],
  ["barra y dos invertidas", "/\\\\evil.com"],
  ["dos invertidas", "\\\\evil.com"],
  ["javascript:", "javascript:alert(1)"],
  ["data:", "data:text/html,hola"],
  ["doble barra codificada", "%2F%2Fevil.com"],
  ["barra y doble barra codificada", "/%2F%2Fevil.com"],
  ["barra invertida codificada", "/%5Cevil.com"],
  ["doblemente codificada", "%252F%252Fevil.com"],
  ["tabulación escondida", "/\tevil.com"],
  ["salto de línea escondido", "/evil.com\n"],
  ["bucle al login", "/login?next=/week"],
  ["bucle al callback", "/auth/callback?code=x"],
  ["bucle a recuperar", "/recuperar"],
  ["vacía", ""],
  ["solo espacios", "   "],
];

const INTERNAS: [string, string][] = [
  ["/", "/"],
  [" /week", "/week"],
  ["/family", "/family"],
  ["/shopping", "/shopping"],
  ["/eventos", "/eventos"],
  ["/eventos?id=123", "/eventos?id=123"],
  ["/family?tab=members", "/family?tab=members"],
  ["/invite/abc123def456ghi789", "/invite/abc123def456ghi789"],
  ["/nueva-contrasena", "/nueva-contrasena"],
  ["/eventos#arriba", "/eventos"],
  ["/a/../plan", "/plan"],
];

describe("destinoInterno: lo que rechaza", () => {
  for (const [nombre, valor] of ATAQUES) {
    it(`${nombre}: ${JSON.stringify(valor)} → por omisión`, () => {
      expect(destinoInterno(valor)).toBe("/");
      expect(destinoInterno(valor, "/family")).toBe("/family");
    });
  }

  it("lo que no es texto → por omisión", () => {
    for (const raro of [null, undefined, 42, {}, [], true]) {
      expect(destinoInterno(raro)).toBe("/");
    }
  });
});

describe("destinoInterno: lo que acepta, y cómo lo devuelve", () => {
  for (const [entrada, salida] of INTERNAS) {
    it(`${JSON.stringify(entrada)} → ${salida}`, () => {
      expect(destinoInterno(entrada)).toBe(salida);
    });
  }

  it("nunca devuelve algo que empiece con dos barras ni tenga barra invertida", () => {
    // La propiedad, además de los ejemplos: sobre todo lo que se le ocurra a un
    // fuzz corto, lo que sale es interno o es el valor por omisión.
    const semillas = ["/", "//", "\\", "%2F", "%5C", "evil.com", ":", "http", "\t", "#", "?"];
    for (const a of semillas) {
      for (const b of semillas) {
        const r = destinoInterno(a + b + "x");
        expect(r.startsWith("/")).toBe(true);
        expect(r.startsWith("//")).toBe(false);
        expect(r.includes("\\")).toBe(false);
      }
    }
  });
});
