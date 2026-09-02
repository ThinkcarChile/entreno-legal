import { describe, expect, it } from "vitest";
import { nuevaClaveDeIntento } from "./clave-intento";

/**
 * LA CLAVE TIENE QUE DISTINGUIR DOS ACTOS IGUALES.
 *
 * Es la propiedad entera: si dos intentos distintos pudieran producir la misma
 * clave, el servidor colapsaría dos fuentes que salieron de verdad a la mesa en
 * una sola —que es exactamente el defecto que la clave vino a cerrar—.
 */
describe("la clave de un intento", () => {
  it("es distinta cada vez que se pide", () => {
    let n = 0;
    const fuente = {
      randomUUID: () => {
        n += 1;
        return `11111111-1111-4111-8111-00000000000${n}`;
      },
    };
    expect(nuevaClaveDeIntento(fuente)).not.toBe(nuevaClaveDeIntento(fuente));
  });

  it("cae a los bytes aleatorios cuando el navegador no tiene randomUUID", () => {
    let semilla = 0;
    const fuente = {
      getRandomValues: (a: Uint8Array) => {
        semilla += 1;
        a.fill(semilla);
        return a;
      },
    };
    const uno = nuevaClaveDeIntento(fuente);
    const dos = nuevaClaveDeIntento(fuente);
    expect(uno).toHaveLength(32);
    expect(uno).not.toBe(dos);
    // Entra tal cual en el campo del servidor (120 caracteres, sin controles).
    expect(uno).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sin fuente de aleatoriedad devuelve null y NO una clave inventada", () => {
    // `null` = sin idempotencia: el servidor escribe cada llamada. Es lo
    // correcto cuando no se puede distinguir un reintento de un acto nuevo;
    // una clave débil volvería a tragarse hechos reales.
    expect(nuevaClaveDeIntento(undefined)).toBeNull();
    expect(nuevaClaveDeIntento({})).toBeNull();
  });
});
