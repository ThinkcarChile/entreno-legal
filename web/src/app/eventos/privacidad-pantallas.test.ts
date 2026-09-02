import { readFileSync } from "node:fs";
import path from "node:path";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * GUARDIÁN: la superficie del evento no toca datos clínicos ni la nota de
 * alergia del invitado.
 *
 * Esta pantalla se mira con gente alrededor. Está abierta sobre la mesa
 * mientras se cocina, se la pasa uno a otro para agregar al que llegó, y a
 * veces se proyecta en el televisor del living. Un diagnóstico, un límite
 * clínico o la frase que la tía escribió sobre su alergia no pueden aparecer
 * ahí ni por un descuido de una línea.
 *
 * La regla operativa es la misma que en "Lo que comimos": lo que la pantalla no
 * muestra tampoco lo PIDE. Si nadie consulta la columna, nadie la puede filtrar
 * después por accidente al agregar un campo a una tarjeta.
 *
 * Este test lee el código de la carpeta. No es elegante, pero es el único que
 * se rompe el día que alguien agregue `allergy_note` a un `.select()` para
 * "mostrar un detallito más".
 */

const CARPETA = __dirname;

/**
 * Columnas y conceptos prohibidos en esta superficie.
 *
 * `sex`, `approx_weight_kg` y `approx_height_cm` existen en la ficha del
 * invitado y son opcionales; el evento no los necesita para nada, y pedirlos
 * los pondría a un `map` de distancia de terminar en pantalla.
 */
const PROHIBIDOS = [
  "allergy_note",
  "clinical_status",
  "meal_serving_clinical_context",
  "medical_access",
  "clinical_assessments",
  "member_clinical",
  "lab_results",
  "approx_weight_kg",
  "approx_height_cm",
];

/**
 * `revisiones.ts` menciona varios de estos nombres a propósito: ahí vive la
 * lista negra que el snapshot congelado hace cumplir. Y los tests, obviamente,
 * tienen que poder nombrar lo que prohíben.
 */
const EXENTOS = new Set(["revisiones.ts"]);

/** Saca comentarios para que un texto explicativo no dispare el guardián. */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("la pantalla del evento no muestra nada clínico", () => {
  it("ningún archivo de /eventos consulta ni dibuja columnas clínicas", () => {
    const archivos = globSync("**/*.{ts,tsx}", { cwd: CARPETA }).filter(
      (f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx") && !EXENTOS.has(path.basename(f)),
    );
    // Si la carpeta quedara vacía el test pasaría sin comprobar nada, y un
    // guardián que no mira nada es peor que no tener guardián.
    expect(archivos.length).toBeGreaterThan(5);

    const infractores: string[] = [];
    for (const archivo of archivos) {
      const texto = sinComentarios(readFileSync(path.join(CARPETA, archivo), "utf8"));
      texto.split("\n").forEach((linea, i) => {
        for (const prohibido of PROHIBIDOS) {
          if (linea.includes(prohibido)) {
            infractores.push(`${archivo.replace(/\\/g, "/")}:${i + 1} → ${prohibido}`);
          }
        }
      });
    }
    expect(infractores).toEqual([]);
  });

  /**
   * El motor SÍ sabe qué no puede comer cada integrante (se lo dice
   * `public.event_menu_blocks`, que cruza el permiso médico a propósito para
   * que una alergia registrada no se lea como "puede comer todo"). Esa
   * información entra al CÁLCULO y no puede salir por la pantalla: en el panel
   * se muestran conteos —"N personas con restricciones registradas"— y jamás
   * quién ni por qué.
   *
   * Este test es el que se rompe el día que alguien pinte una lista de
   * "platos que fulano no puede comer" para ayudar al anfitrión.
   */
  it("lo que la casa sabe llega al motor, pero no a ninguna pantalla", () => {
    const pantallas = globSync("**/*.tsx", { cwd: CARPETA }).filter(
      (f) => !f.endsWith(".test.tsx"),
    );
    expect(pantallas.length).toBeGreaterThan(5);

    const infractores: string[] = [];
    for (const archivo of pantallas) {
      const texto = sinComentarios(readFileSync(path.join(CARPETA, archivo), "utf8"));
      for (const prohibido of [
        "recordedBlocks",
        "blockedItemIds",
        "allergyItemIds",
        "event_menu_blocks",
        "cargarBloqueosDelMenu",
      ]) {
        if (texto.includes(prohibido)) {
          infractores.push(`${archivo.replace(/\\/g, "/")} → ${prohibido}`);
        }
      }
    }
    expect(infractores).toEqual([]);
  });

  it("la lista de invitados se pide sin la nota de alergia", () => {
    const queries = readFileSync(path.join(CARPETA, "queries.ts"), "utf8");
    // La bandera SÍ viaja: es lo único que el motor necesita para exigir
    // revisión cuando el menú no permite servir con seguridad.
    expect(queries).toContain("dietary_flags");
    expect(sinComentarios(queries)).not.toContain("allergy_note");
  });
});
