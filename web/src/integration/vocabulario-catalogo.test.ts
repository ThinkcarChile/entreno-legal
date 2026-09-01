import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BIBLIOTECA, RECETAS_EXISTENTES } from "@/domain/recipes/library";
import { levantarBase, type Harness } from "./harness";

/**
 * EL VOCABULARIO QUE LEEN LOS AUTORES DE RECETAS, derivado y vigilado.
 *
 * `docs/recetas/vocabulario-catalogo.md` es el archivo que cada agente autor
 * lee ANTES de escribir un lote: la lista de identidades que existen (para no
 * redeclararlas) y de recetas publicadas (para no repetirlas). Lo generó un
 * agente una vez… y el generador no quedó en el repo. Resultado inevitable:
 * después de los lotes F y G el archivo seguía diciendo "84 alimentos y 109
 * recetas" cuando la base de pruebas tiene el doble — y un autor que lea eso va
 * a declarar "champiñón" como alimento nuevo por segunda vez, que es
 * exactamente la identidad partida que ya costó una ronda de correcciones.
 *
 * Mismo remedio que el registro acumulado: el documento se DERIVA de la base
 * real, y este test falla si el archivo commiteado y la realidad se separan.
 *
 *   REGENERAR_VOCABULARIO=1 npx vitest run src/integration/vocabulario-catalogo.test.ts
 */

let h: Harness;
const RUTA = path.resolve(__dirname, "../../../docs/recetas/vocabulario-catalogo.md");

interface FilaAlimento {
  canonical_name: string;
  categoria: string | null;
  bases: string;
  edible_portion_factor: string | null;
  medidas: string | null;
}

beforeAll(async () => {
  h = await levantarBase();
}, 300_000);

afterAll(async () => {
  await h?.cerrar();
});

async function generar(): Promise<string> {
  const alimentos = await h.filas<FilaAlimento>(
    `select i.canonical_name,
            c.code as categoria,
            string_agg(distinct f.weight_basis::text || ' (' || f.basis_unit::text || ')', ', '
                       order by f.weight_basis::text || ' (' || f.basis_unit::text || ')') as bases,
            i.edible_portion_factor::text,
            (select string_agg(m.measure_name || ' = ' || m.quantity::text || ' ' || m.unit, ', ')
             from public.household_measures m where m.ingredient_id = i.id) as medidas
     from public.ingredients i
     left join public.ingredient_categories c on c.id = i.category_id
     left join public.nutrition_facts f on f.ingredient_id = i.id
     where i.household_id is null
     group by i.id, i.canonical_name, c.code, i.edible_portion_factor
     order by i.canonical_name`,
  );

  const rendimientos = await h.filas<{ nombre: string; metodo: string; factor: string }>(
    `select i.canonical_name as nombre, y.cooking_method::text as metodo, y.yield_factor::text as factor
     from public.ingredient_yields y
     join public.ingredients i on i.id = y.ingredient_id
     where i.household_id is null
     order by i.canonical_name, y.cooking_method::text`,
  );
  const rendimientoDe = new Map<string, string[]>();
  for (const r of rendimientos) {
    const lista = rendimientoDe.get(r.nombre) ?? [];
    lista.push(`${r.metodo} ${Number(r.factor)}x`);
    rendimientoDe.set(r.nombre, lista);
  }

  // Los nombres publicados: lo que la base trae de fábrica más la biblioteca
  // tipada entera. Un autor no puede repetir NINGUNO de los dos.
  const publicadas = [...RECETAS_EXISTENTES, ...BIBLIOTECA.map((r) => r.name)].sort((a, b) =>
    a.localeCompare(b, "es"),
  );

  const filas = alimentos.map((a) => {
    const rend = rendimientoDe.get(a.canonical_name);
    const porcion = a.edible_portion_factor === null ? "—" : Number(a.edible_portion_factor).toString();
    return `| \`${a.canonical_name}\` | ${a.categoria ?? "—"} | ${a.bases ?? "—"}${rend ? ` · rinde ${rend.join(", ")}` : ""} | ${porcion} | ${a.medidas ?? "—"} |`;
  });

  return `# Vocabulario del catálogo — generado, no editar a mano

**ARCHIVO GENERADO** desde la base real por
\`web/src/integration/vocabulario-catalogo.test.ts\`, que falla si este archivo y
la base se separan. Se regenera con \`REGENERAR_VOCABULARIO=1\`.

Es la ÚNICA lista de identidades contra la que la biblioteca puede escribir. Un
nombre que no esté acá no existe: o se usa el que sí está, o se declara en
\`alimentosNuevos\`. La primera versión de este archivo la escribió un agente a
mano y quedó pegada en "84 alimentos" mientras la base llegaba a ${alimentos.length}: un
autor que la leyera habría redeclarado identidades que ya existían.

## Alimentos disponibles (${alimentos.length})

La columna **bases** manda: si una receta pide una base que el alimento no
tiene, el generador de seed revienta nombrando alimento y base.

| canonical_name | categoría | bases disponibles | porción comestible | medidas |
|---|---|---|---|---|
${filas.join("\n")}

## Recetas ya publicadas (${publicadas.length}) — NO repetir

Ni el nombre exacto ni el mismo plato con otro nombre. Un plato que solo cambia
la salsa contra uno publicado es una variante: o la diferencia culinaria se nota
de verdad, o va a \`noEscritos\` con su razón.

${publicadas.map((n) => `- ${n}`).join("\n")}
`;
}

describe("el vocabulario de los autores no se separa de la base", () => {
  it("el archivo commiteado es exactamente lo que la base produce hoy", async () => {
    const doc = await generar();
    if (process.env.REGENERAR_VOCABULARIO === "1") writeFileSync(RUTA, doc);
    expect(readFileSync(RUTA, "utf8")).toBe(doc);
  }, 300_000);
});
