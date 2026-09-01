import { describe, expect, it } from "vitest";
import { BIBLIOTECA, generarSeedSQL } from ".";
import { ordenarPorDependencias } from "./seed";
import type { LibraryRecipe } from "./types";

/**
 * GUARDIANES DEL GENERADOR (§36b).
 *
 * `biblioteca.test.ts` verifica que el archivo SQL commiteado sea igual a lo
 * que produce el generador. Eso detecta que alguien editó el seed a mano, pero
 * NO detecta que el generador esté produciendo basura: si el generador se
 * rompe, el archivo se regenera roto y la comparación sigue dando igual.
 *
 * Estos tests miran el CONTENIDO. Nacieron de un error real: una edición dejó
 * un `")}` suelto dentro del SQL y el guardián de sincronía lo dejó pasar.
 */

describe("orden de creación con recetas anidadas", () => {
  it("una receta que reutiliza otra se emite después de ella", () => {
    const orden = ordenarPorDependencias(BIBLIOTECA).map((r) => r.slug);
    for (const r of BIBLIOTECA) {
      for (const n of r.nested ?? []) {
        const dependencia = BIBLIOTECA.find((x) => x.slug === n.slug);
        if (!dependencia) continue; // externa: ya está publicada en la base
        expect(
          orden.indexOf(dependencia.slug),
          `${dependencia.slug} debe crearse antes que ${r.slug}`,
        ).toBeLessThan(orden.indexOf(r.slug));
      }
    }
  });

  it("no pierde ni duplica recetas al ordenar", () => {
    const orden = ordenarPorDependencias(BIBLIOTECA);
    expect(orden.length).toBe(BIBLIOTECA.length);
    expect(new Set(orden.map((r) => r.slug)).size).toBe(BIBLIOTECA.length);
  });

  it("un ciclo de anidamiento se declara en vez de resolverse a la fuerza", () => {
    const receta = (slug: string, anida: string): LibraryRecipe => ({
      slug,
      name: slug,
      description: "receta de prueba para el ciclo, no es comida real",
      category: "TRADICIONAL",
      kind: "MEAL",
      mealTypes: ["LUNCH"],
      baseServings: 4,
      prepMinutes: 1,
      cookMinutes: 1,
      difficulty: "FACIL",
      components: [],
      nested: [{ slot: "SALAD", slug: anida }],
      steps: [],
      tags: [],
    });
    expect(() => ordenarPorDependencias([receta("a", "b"), receta("b", "a")])).toThrow(/ciclo/);
  });

  it("un slug anidado inexistente falla al generar, no al aplicar el SQL", () => {
    const rota: LibraryRecipe = {
      ...BIBLIOTECA[0]!,
      slug: "receta-rota",
      name: "Receta rota",
      nested: [{ slot: "SALAD", slug: "ensalada-que-no-existe" }],
    };
    expect(() => generarSeedSQL([...BIBLIOTECA, rota])).toThrow(/ensalada-que-no-existe/);
  });
});

describe("el SQL generado es SQL", () => {
  const sql = generarSeedSQL(BIBLIOTECA);
  const lineas = sql.split("\n");

  it("no filtra sintaxis de JavaScript", () => {
    const fuga = /^\s*(["'`]\)?\}|\$\{)/;
    const sospechosas = lineas
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => fuga.test(l));
    expect(sospechosas.map((x) => `${x.n}: ${x.l}`)).toEqual([]);
  });

  it("los delimitadores $$ quedan balanceados", () => {
    // No se cuentan `do $$` contra `end $$;`: las funciones auxiliares también
    // terminan en `end $$;` y el conteo daría distinto siempre. Lo que sí tiene
    // que cumplirse es que cada `$$` que abre tenga uno que cierra.
    const dolares = (sql.match(/\$\$/g) ?? []).length;
    expect(dolares % 2, `hay ${dolares} delimitadores $$, un número impar`).toBe(0);

    const bloques = lineas.filter((l) => l.trim() === "do $$").length;
    expect(bloques).toBeGreaterThan(0);
    expect(sql.trimEnd().endsWith("end $$;")).toBe(true);
  });

  it("toda línea ejecutable empieza por algo que Postgres entiende", () => {
    // Barrido grueso a propósito: no valida SQL, detecta que se coló algo que
    // no es SQL. La validación de verdad la hace el canario aplicando el
    // archivo contra un PostgreSQL real.
    const inicios =
      /^(--|\/\*|\*|do \$\$|end \$\$;|declare|begin|end|for |from |join |where |on |values|insert|select|update|if |raise|perform|create|alter|comment|return|\$\$|\)|\s|$)/i;
    const raras = lineas
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => l.length > 0 && !inicios.test(l));
    expect(raras.map((x) => `${x.n}: ${x.l}`)).toEqual([]);
  });
});
