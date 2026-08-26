#!/usr/bin/env node
/**
 * Convierte un lote de recetas en JSON a un archivo TypeScript de la biblioteca.
 *
 *   node scripts/lote-desde-json.mjs B ruta/al/lote-b.json
 *
 * Por qué existe: las recetas de los lotes B-E las escriben agentes en paralelo.
 * Si cada uno escribiera TypeScript a mano tendríamos errores de sintaxis, estilos
 * distintos y conflictos al juntar. Devuelven DATOS validados por schema y este
 * conversor emite el código — determinista, con el mismo formato siempre.
 *
 * El conversor NO arregla nada en silencio. Si una receta no cumple el contrato,
 * falla nombrando el problema. Los guardianes de `biblioteca.test.ts` corren
 * después y son la segunda barrera, no la primera.
 */

import { readFileSync, writeFileSync } from "node:fs";

const [, , letra, entrada] = process.argv;
if (!letra || !entrada) {
  console.error("uso: node scripts/lote-desde-json.mjs <B..Z> <archivo.json>");
  process.exit(1);
}

const datos = JSON.parse(readFileSync(entrada, "utf8"));
const recetas = Array.isArray(datos) ? datos : datos.recetas;
if (!Array.isArray(recetas)) {
  console.error("el JSON debe ser un arreglo de recetas o { recetas: [...] }");
  process.exit(1);
}

// --------------------------------------------------------------- validaciones
const BASES = ["RAW", "COOKED", "DRAINED", "EDIBLE_PORTION", "AS_PACKAGED"];
const ROLES = ["MAIN", "ADDED_FAT", "SEASONING"];
const AJUSTES = ["FIXED", "ADJUSTABLE", "OPTIONAL"];
const UNIDADES = ["G", "ML", "UNIT"];

const errores = [];
const marcar = (slug, msg) => errores.push(`${slug}: ${msg}`);

for (const r of recetas) {
  const slug = r.slug ?? "(sin slug)";
  if (!r.slug || !/^[a-z0-9-]+$/.test(r.slug)) marcar(slug, "slug ausente o con caracteres no permitidos");
  if (!r.name) marcar(slug, "sin nombre");
  if (!r.description || r.description.length < 20) marcar(slug, "descripción ausente o demasiado corta");
  if (!Array.isArray(r.components) || r.components.length === 0) marcar(slug, "sin componentes");
  if (!Array.isArray(r.steps) || r.steps.length === 0) marcar(slug, "sin pasos");
  if (!(r.baseServings > 0)) marcar(slug, "baseServings inválido");

  for (const c of r.components ?? []) {
    const q = `${slug}/${c.ingredient}`;
    if (!c.ingredient) marcar(slug, "componente sin ingrediente");
    if (!BASES.includes(c.basis)) marcar(q, `base física inválida: ${c.basis}`);
    if (!UNIDADES.includes(c.unit)) marcar(q, `unidad inválida: ${c.unit}`);
    if (!ROLES.includes(c.role)) marcar(q, `rol inválido: ${c.role}`);
    if (!AJUSTES.includes(c.adjustability)) marcar(q, `ajustabilidad inválida: ${c.adjustability}`);
    if (!(c.quantity > 0)) marcar(q, "cantidad no positiva");
    if (c.optional && c.adjustability !== "OPTIONAL") marcar(q, "opcional pero no ajustable a OPCIONAL");
    if (c.minQuantity !== undefined && c.minQuantity > c.quantity) marcar(q, "minQuantity mayor que la cantidad");
    if (c.maxQuantity !== undefined && c.maxQuantity < c.quantity) marcar(q, "maxQuantity menor que la cantidad");
    if (c.yieldFactor !== undefined && !(c.yieldFactor > 0 && c.yieldFactor <= 5))
      marcar(q, `rendimiento fuera de rango: ${c.yieldFactor}`);
    if (c.role === "ADDED_FAT" && !String(c.ingredient).startsWith("aceite"))
      marcar(q, "ADDED_FAT solo vale para aceites añadidos (ADR 0004)");
  }

  for (const p of r.steps ?? []) {
    if (!p.instruction || p.instruction.trim().length < 10) marcar(slug, "paso con instrucción vacía o demasiado corta");
    if (p.optionalCapability && !p.manualAlternative)
      marcar(slug, `paso con capacidad ${p.optionalCapability} sin alternativa manual`);
  }

  if (r.batchPrepNotes && /\b\d+\s*(d[ií]as?|semanas?|meses?|horas?)\b/i.test(r.batchPrepNotes))
    marcar(slug, "las notas de lote no pueden prometer plazos de seguridad");
}

const slugs = recetas.map((r) => r.slug);
const repetidos = slugs.filter((s, i) => slugs.indexOf(s) !== i);
if (repetidos.length) errores.push(`slugs repetidos dentro del lote: ${[...new Set(repetidos)].join(", ")}`);

if (errores.length) {
  console.error(`\n${errores.length} problema(s) — no se generó nada:\n`);
  for (const e of errores) console.error(`  - ${e}`);
  process.exit(1);
}

// ------------------------------------------------------------------- emisión
const lit = (v) => JSON.stringify(v);

/** Emite un objeto en una línea si es corto, y multilínea si no. */
function objeto(campos, sangria) {
  const pares = campos.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`);
  const unaLinea = `{ ${pares.join(", ")} }`;
  if (unaLinea.length + sangria.length <= 110) return unaLinea;
  return `{\n${pares.map((p) => `${sangria}  ${p}`).join(",\n")},\n${sangria}}`;
}

function componente(c, sangria) {
  return objeto(
    [
      ["ingredient", lit(c.ingredient)],
      ["quantity", String(c.quantity)],
      ["unit", lit(c.unit)],
      ["basis", lit(c.basis)],
      ["slot", lit(c.slot)],
      ["role", lit(c.role)],
      ["adjustability", lit(c.adjustability)],
      ["minQuantity", c.minQuantity !== undefined ? String(c.minQuantity) : undefined],
      ["maxQuantity", c.maxQuantity !== undefined ? String(c.maxQuantity) : undefined],
      ["cookingMethod", c.cookingMethod ? lit(c.cookingMethod) : undefined],
      ["yieldFactor", c.yieldFactor !== undefined ? String(c.yieldFactor) : undefined],
      [
        "cut",
        c.cut
          ? `{ kind: ${lit(c.cut.kind)}${c.cut.sizeMm !== undefined ? `, sizeMm: ${c.cut.sizeMm}` : ""} }`
          : undefined,
      ],
      ["optional", c.optional ? "true" : undefined],
      ["notes", c.notes ? lit(c.notes) : undefined],
    ],
    sangria,
  );
}

function paso(p, sangria) {
  return objeto(
    [
      ["instruction", lit(p.instruction)],
      ["minutes", p.minutes !== undefined ? String(p.minutes) : undefined],
      ["temperatureC", p.temperatureC !== undefined ? String(p.temperatureC) : undefined],
      ["optionalCapability", p.optionalCapability ? lit(p.optionalCapability) : undefined],
      ["manualAlternative", p.manualAlternative ? lit(p.manualAlternative) : undefined],
      ["parallelGroup", p.parallelGroup !== undefined ? String(p.parallelGroup) : undefined],
    ],
    sangria,
  );
}

function alternativa(a, sangria) {
  return objeto(
    [
      ["slot", lit(a.slot)],
      ["ingredient", lit(a.ingredient)],
      ["compatibility", lit(a.compatibility)],
      ["quantityEquivalence", a.quantityEquivalence !== undefined ? String(a.quantityEquivalence) : undefined],
      ["notes", a.notes ? lit(a.notes) : undefined],
    ],
    sangria,
  );
}

const cuerpo = recetas
  .map((r) => {
    const lineas = [];
    lineas.push("  {");
    lineas.push(`    slug: ${lit(r.slug)},`);
    lineas.push(`    name: ${lit(r.name)},`);
    lineas.push(`    description:\n      ${lit(r.description)},`);
    lineas.push(`    category: ${lit(r.category)},`);
    lineas.push(`    kind: ${lit(r.kind ?? "MEAL")},`);
    lineas.push(`    mealTypes: [${r.mealTypes.map(lit).join(", ")}],`);
    lineas.push(`    baseServings: ${r.baseServings},`);
    lineas.push(`    prepMinutes: ${r.prepMinutes},`);
    lineas.push(`    cookMinutes: ${r.cookMinutes},`);
    lineas.push(`    difficulty: ${lit(r.difficulty)},`);
    lineas.push(`    components: [`);
    for (const c of r.components) lineas.push(`      ${componente(c, "      ")},`);
    lineas.push(`    ],`);
    if (r.alternatives?.length) {
      lineas.push(`    alternatives: [`);
      for (const a of r.alternatives) lineas.push(`      ${alternativa(a, "      ")},`);
      lineas.push(`    ],`);
    }
    if (r.nested?.length) {
      lineas.push(`    nested: [`);
      for (const n of r.nested)
        lineas.push(
          `      { slot: ${lit(n.slot)}, slug: ${lit(n.slug)}${n.servingsFactor !== undefined ? `, servingsFactor: ${n.servingsFactor}` : ""} },`,
        );
      lineas.push(`    ],`);
    }
    lineas.push(`    steps: [`);
    for (const p of r.steps) lineas.push(`      ${paso(p, "      ")},`);
    lineas.push(`    ],`);
    lineas.push(`    tags: [${(r.tags ?? []).map(lit).join(", ")}],`);
    if (r.batchPrepNotes) lineas.push(`    batchPrepNotes:\n      ${lit(r.batchPrepNotes)},`);
    lineas.push("  },");
    return lineas.join("\n");
  })
  .join("\n");

const salida = `import type { LibraryRecipe } from "./types";

/**
 * LOTE ${letra} — ${recetas.length} recetas chilenas (Sprint 11.5).
 *
 * ARCHIVO GENERADO desde datos validados. Se produce con
 * \`node scripts/lote-desde-json.mjs ${letra} <json>\`. Editarlo a mano es
 * posible pero desaconsejado: la próxima regeneración lo pisa.
 *
 * Las reglas que gobiernan estas recetas están en \`lote-a.ts\` y se verifican
 * en \`biblioteca.test.ts\`. Las dos que más se olvidan:
 *
 * - Toda cantidad declara su base física. El generador de seed revienta si el
 *   alimento no tiene ficha para esa base.
 * - El rendimiento crudo→cocido se declara SOLO donde hay dato. Ausente
 *   significa desconocido; jamás se rellena con 1.
 */
export const LOTE_${letra}: LibraryRecipe[] = [
${cuerpo}
];
`;

const destino = `web/src/domain/recipes/library/lote-${letra.toLowerCase()}.ts`;
writeFileSync(destino, salida, "utf8");
console.log(`${destino}: ${recetas.length} recetas, ${recetas.reduce((t, r) => t + r.components.length, 0)} componentes`);
