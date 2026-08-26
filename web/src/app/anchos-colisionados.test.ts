import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { globSync } from "node:fs";

/**
 * GUARDIÁN: los nombres de la escala de espaciado le ganan a los de ancho.
 *
 * El kit define `--spacing-xs/sm/md/lg/xl` para la escala Material 3. Tailwind
 * usa ESOS MISMOS nombres para los anchos (`max-w-sm`, `max-w-md`…), y cuando
 * un nombre existe en la escala de espaciado, gana: `max-w-sm` no significa
 * 24rem, significa 8 PÍXELES.
 *
 * El login quedó en una columna de ocho píxeles, con una palabra por línea.
 * Y el choque venía de antes de la migración de diseño: `error.tsx` y
 * `not-found.tsx` lo arrastraban en silencio, porque una página de error
 * angosta no molesta lo suficiente como para que alguien la reporte.
 *
 * Definir `--container-*` NO lo arregla: la escala de espaciado tiene
 * prioridad. La salida es no usar esas utilidades y poner el ancho explícito.
 */

const RAIZ = path.resolve(__dirname, "..");

/** Utilidades de tamaño cuyo sufijo choca con la escala de espaciado del kit. */
const COLISION = /\b(?:max-w|min-w|max-h|min-h|w|h)-(?:xs|sm|md|lg|xl|xxl|base|gutter)\b/g;

describe("anchos que chocan con la escala de espaciado", () => {
  it("ninguna utilidad de tamaño usa un nombre de la escala de espaciado", () => {
    const archivos = globSync("**/*.{tsx,ts}", { cwd: RAIZ })
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
      .map((f) => path.join(RAIZ, f));

    const infractores: string[] = [];
    for (const archivo of archivos) {
      const texto = readFileSync(archivo, "utf8");
      texto.split("\n").forEach((linea, i) => {
        for (const m of linea.matchAll(COLISION)) {
          infractores.push(
            `${path.relative(RAIZ, archivo).replace(/\\/g, "/")}:${i + 1} → ${m[0]} ` +
              `(resuelve a la escala de espaciado, no al ancho; usa max-w-[24rem] y compañía)`,
          );
        }
      });
    }
    expect(infractores).toEqual([]);
  });
});
