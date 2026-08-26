#!/usr/bin/env node
/**
 * Suma alimentos nuevos a `INGREDIENTES_NUEVOS` desde un JSON de fichas.
 *
 *   node scripts/alimentos-desde-json.mjs ruta/alimentos.json
 *
 * Existe por la misma razón que el conversor de recetas: las fichas las escribe
 * un agente y el código lo emite un programa. Pero acá hay una regla adicional
 * que este script hace cumplir sin excepciones:
 *
 *   **Un nutriente ausente se queda ausente.**
 *
 * En la base, NULL significa DESCONOCIDO. Si una ficha llega con `potassiumMg: 0`
 * sin que ese cero sea real, el motor clínico le diría a alguien con restricción
 * de potasio que el alimento cumple, cuando en verdad nadie lo sabe. El script
 * rechaza los ceros sospechosos en micronutrientes en vez de escribirlos.
 */

import { readFileSync, writeFileSync } from "node:fs";

const [, , entrada] = process.argv;
if (!entrada) {
  console.error("uso: node scripts/alimentos-desde-json.mjs <archivo.json>");
  process.exit(1);
}

const datos = JSON.parse(readFileSync(entrada, "utf8"));
const alimentos = Array.isArray(datos) ? datos : datos.alimentos;

const RUTA = "web/src/domain/recipes/library/catalog.ts";
const fuente = readFileSync(RUTA, "utf8");

// Identidades que ya existen: ni las del catálogo ni las ya agregadas se repiten.
const yaNuevos = [...fuente.matchAll(/canonicalName: "([^"]+)"/g)].map((m) => m[1]);
const yaExistentes = [
  ...fuente
    .slice(fuente.indexOf("INGREDIENTES_EXISTENTES"))
    .matchAll(/^\s{2}"([^"]+)",$/gm),
].map((m) => m[1]);
const ocupados = new Set([...yaNuevos, ...yaExistentes]);

/**
 * SOBRE LOS CEROS SOSPECHOSOS
 *
 * La regla —cuándo un 0 en un micronutriente es un hecho y cuándo es relleno—
 * vive en UN solo lugar: `ceroEsDefendible` en
 * `web/src/domain/recipes/library/expectativas.ts`, y la hace cumplir el
 * guardián §30 de `biblioteca.test.ts`.
 *
 * Este script tuvo su propia copia y duró exactamente una tanda: la copia
 * rechazaba la fibra 0 de la mantequilla, que es un hecho, mientras la otra la
 * aceptaba. Una regla con matices duplicada en dos lenguajes se desincroniza
 * sola. Acá quedan solo las validaciones estructurales.
 */

const errores = [];
const aceptados = [];

for (const a of alimentos) {
  if (!a.canonicalName) { errores.push("ficha sin canonicalName"); continue; }
  if (ocupados.has(a.canonicalName)) {
    errores.push(`${a.canonicalName}: ya existe como identidad — no se puede duplicar`);
    continue;
  }
  if (!a.nutrition?.length) { errores.push(`${a.canonicalName}: sin ninguna ficha nutricional`); continue; }

  for (const n of a.nutrition) {
    if (n.energyKcal === undefined && n.proteinG === undefined) {
      errores.push(`${a.canonicalName} (${n.basis}): sin energía ni proteína, la ficha no sirve para nada`);
    }
  }
  ocupados.add(a.canonicalName);
  aceptados.push(a);
}

if (errores.length) {
  console.error(`\n${errores.length} problema(s) — no se agregó nada:\n`);
  for (const e of errores) console.error(`  - ${e}`);
  process.exit(1);
}

const lit = (v) => JSON.stringify(v);
const campo = (k, v) => (v === undefined ? null : `${k}: ${typeof v === "string" ? lit(v) : v}`);

const bloques = aceptados
  .map((a) => {
    const l = ["  {"];
    l.push(`    canonicalName: ${lit(a.canonicalName)},`);
    l.push(`    displayName: ${lit(a.displayName)},`);
    l.push(`    category: ${lit(a.category)},`);
    if (a.aliases?.length) l.push(`    aliases: [${a.aliases.map(lit).join(", ")}],`);
    if (a.ediblePortionFactor !== undefined) l.push(`    ediblePortionFactor: ${a.ediblePortionFactor},`);
    if (a.defaultMeasurementType) l.push(`    defaultMeasurementType: ${lit(a.defaultMeasurementType)},`);
    l.push(`    nutrition: [`);
    for (const n of a.nutrition) {
      const pares = [
        campo("basis", n.basis),
        campo("basisUnit", n.basisUnit),
        campo("energyKcal", n.energyKcal),
        campo("proteinG", n.proteinG),
        campo("carbohydratesG", n.carbohydratesG),
        campo("fatG", n.fatG),
        campo("fiberG", n.fiberG),
        campo("sugarsG", n.sugarsG),
        campo("saturatedFatG", n.saturatedFatG),
        campo("sodiumMg", n.sodiumMg),
        campo("potassiumMg", n.potassiumMg),
        campo("phosphorusMg", n.phosphorusMg),
        campo("notes", n.notes),
      ].filter(Boolean);
      const unaLinea = `      { ${pares.join(", ")} },`;
      if (unaLinea.length <= 110) l.push(unaLinea);
      else l.push(`      {\n${pares.map((p) => `        ${p}`).join(",\n")},\n      },`);
    }
    l.push(`    ],`);
    l.push("  },");
    return l.join("\n");
  })
  .join("\n");

// Se insertan al final del arreglo INGREDIENTES_NUEVOS, antes de su `];`.
const marca = "export const INGREDIENTES_NUEVOS: LibraryIngredient[] = [";
const inicio = fuente.indexOf(marca);
if (inicio < 0) { console.error("no encontré INGREDIENTES_NUEVOS en catalog.ts"); process.exit(1); }
const cierre = fuente.indexOf("\n];", inicio);
const salida = fuente.slice(0, cierre) + "\n" + bloques + fuente.slice(cierre);

writeFileSync(RUTA, salida, "utf8");
console.log(`${RUTA}: +${aceptados.length} alimentos (${aceptados.map((a) => a.canonicalName).join(", ")})`);
