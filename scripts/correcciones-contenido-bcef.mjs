#!/usr/bin/env node
/**
 * Correcciones de los lotes B, C, E y F (167 platos: guisos de olla, once y
 * panes, cocina peruana y china-chifa).
 *
 *   node scripts/correcciones-contenido-bcef.mjs .plan/contenido/salida-BCEF.json
 *
 * Mismo contrato que `correcciones-contenido-ad.mjs`: acá van las DECISIONES,
 * cada una con su razón, y el script REVIENTA sin escribir nada si un parche no
 * calza. Una corrección que falla en silencio deja el registro diciendo que el
 * problema está resuelto mientras el plato sigue malo.
 */

import { readFileSync, writeFileSync } from "node:fs";

const archivo = process.argv[2] ?? ".plan/contenido/salida-BCEF.json";
const datos = JSON.parse(readFileSync(archivo, "utf8"));
const recetas = datos.recetas;

const hechos = [];
const fallas = [];

const receta = (slug) => {
  const r = recetas.find((x) => x.slug === slug);
  if (!r) fallas.push(`${slug}: no existe en el lote`);
  return r;
};

function paso(slug, indice, busca, pone) {
  const r = receta(slug);
  if (!r) return;
  const p = r.steps[indice - 1];
  if (!p) return fallas.push(`${slug}: no tiene paso ${indice}`);
  if (!p.instruction.includes(busca))
    return fallas.push(`${slug}/paso ${indice}: no encontré «${busca.slice(0, 45)}…»`);
  p.instruction = p.instruction.replace(busca, pone);
  hechos.push(`${slug}/paso ${indice}: texto corregido`);
}

/** Reescribe la instrucción completa de un paso. */
function reescribirPaso(slug, indice, instruccion, extra = {}) {
  const r = receta(slug);
  if (!r) return;
  const p = r.steps[indice - 1];
  if (!p) return fallas.push(`${slug}: no tiene paso ${indice}`);
  p.instruction = instruccion;
  Object.assign(p, extra);
  hechos.push(`${slug}/paso ${indice}: reescrito`);
}

function insertarPaso(slug, indice, nuevo) {
  const r = receta(slug);
  if (!r) return;
  r.steps.splice(indice - 1, 0, nuevo);
  hechos.push(`${slug}: paso nuevo en posición ${indice}`);
}

function campos(slug, cambios) {
  const r = receta(slug);
  if (!r) return;
  for (const [k, v] of Object.entries(cambios)) {
    hechos.push(`${slug}: ${k} ${JSON.stringify(r[k])} → ${JSON.stringify(v)}`);
    r[k] = v;
  }
}

function componente(slug, ingrediente, cambios, cual = 0) {
  const r = receta(slug);
  if (!r) return;
  const c = r.components.filter((x) => x.ingredient === ingrediente)[cual];
  if (!c) return fallas.push(`${slug}: no tiene componente «${ingrediente}»`);
  for (const [k, v] of Object.entries(cambios)) {
    if (v === null) delete c[k];
    else c[k] = v;
  }
  hechos.push(`${slug}/${ingrediente}: ${Object.keys(cambios).join(", ")}`);
}

// ═══════════════════════════════════════ 1 · EL LIMÓN QUE SE COMÍA CON CÁSCARA
//
// El motor suma el 100 % de lo declarado. Estas recetas declaraban el PESO DE
// LA FRUTA ENTERA —320 g de limón en la leche de tigre, 250 en los cebiches—
// cuando lo que entra al plato es el jugo colado: la cáscara y el bagazo se
// botan delante de uno. Y `limon` es justamente uno de los alimentos que el
// registro 2 marca sin porción comestible, así que el motor no tenía con qué
// descontar: sumaba los 320 g completos.
//
// Se declara lo que se come, que es la regla de la casa. El peso de compra se
// mueve a la instrucción, donde le sirve a la persona.
//
// El factor de porción comestible del limón se declara aparte, en el catálogo
// (dev_catalog_seed.sql): eso arregla la LISTA DE COMPRA de todas las recetas
// que lo usan, incluidas las ya publicadas. Son dos arreglos distintos para dos
// problemas distintos, y hacían falta los dos.
const JUGO = [
  ["leche-de-tigre", 120, "de unos 320 g de limones salen los 120 g de jugo colado"],
  ["cebiche-mixto", 90, "de unos 250 g de limones salen los 90 g de jugo colado"],
  ["tiradito-de-reineta-en-crema-de-aji-amarillo", 90, "de unos 250 g de limones salen los 90 g de jugo"],
];
for (const [slug, gramos, nota] of JUGO) {
  componente(slug, "limon", {
    quantity: gramos,
    minQuantity: Math.round(gramos * 0.75),
    maxQuantity: Math.round(gramos * 1.3),
    notes: `jugo colado, que es lo que entra al plato: ${nota}`,
  });
}

// ═══════════════════════════════ 2 · CAPACIDADES QUE NO SE LEÍAN COMO SUSTITUCIÓN
//
// La regla 7 del contrato pide que el paso con capacidad opcional se redacte
// COMO REEMPLAZO ("En vez de freír en sartén: …") y vaya justo después del paso
// que sustituye. Cuatro recetas lo escribieron como si fuera un paso más, y el
// resultado leído en línea es que la persona cocina dos veces: fríe el pollo
// diez minutos y después lo dora catorce más.
reescribirPaso(
  "cerdo-crocante-a-la-miel-picante",
  4,
  "En vez de freír en sartén: dora los cubos apanados en la air fryer a 200 °C, en una sola capa y sin amontonar, dándolos vuelta a mitad de camino.",
);
reescribirPaso(
  "pollo-crocante-en-salsa-chijaukay",
  4,
  "En vez de freír en sartén: cocina el pollo apanado en la air fryer a 200 °C, por tandas y en una sola capa, dándolo vuelta a la mitad.",
);
reescribirPaso(
  "tacu-tacu-de-porotos",
  3,
  "En vez de la olla común: cuece los porotos remojados en la olla a presión, contando los 25 minutos desde que la válvula empieza a sonar.",
);
reescribirPaso(
  "asado-a-la-olla-al-vino-tinto",
  5,
  "En vez de las dos horas y media a fuego mínimo: cierra la olla a presión y cocina 50 minutos contados desde que la válvula suena; deja que pierda presión sola antes de abrir.",
);

// crema-de-rocoto — el paso con licuadora NO sustituía a ninguno: era el único
// paso de molienda, y el camino sin equipo vivía SOLO dentro de
// `manualAlternative`. O sea, quien no tiene licuadora no tenía receta. Se
// parte en dos: el paso base a mano, y la licuadora como lo que es.
reescribirPaso(
  "crema-de-rocoto",
  3,
  "Muele el rocoto blanqueado con el quesillo, el aceite y la sal en el mortero, o aplástalo con un tenedor contra el bol, hasta que quede una crema pareja.",
  { minutes: 12, optionalCapability: null, manualAlternative: null },
);
insertarPaso("crema-de-rocoto", 4, {
  instruction:
    "En vez de moler a mano: licúa el rocoto blanqueado con el quesillo, el aceite y la sal hasta que quede una crema lisa.",
  minutes: 4,
  optionalCapability: "BLENDER",
  manualAlternative: "Sin licuadora: el mortero o el tenedor del paso anterior, que es el camino base.",
});
campos("crema-de-rocoto", { cookMinutes: 15, prepMinutes: 17 });

// ══════════════════════════════════ 3 · ANIDAR UN PLATO NO ES ANIDAR UN RELLENO
//
// Cuatro recetas anidaban el plato COMPLETO con factor 0,5 y después el paso 1
// mandaba sacarle justo lo que no cabe: el ají de gallina 0,5 metía ~120 g de
// arroz crudo, medio huevo duro y aceitunas que la propia instrucción excluye
// ("sin el arroz ni las guarniciones"). El motor cobraba ese arroz igual, en la
// nutrición y en la lista de compra.
//
// El factor baja a lo que de verdad entra como relleno. No es una estimación
// cómoda: el ají de gallina rinde ~800 g para 4 porciones, de los cuales el
// arroz y las guarniciones son la mitad larga; ~65 g de relleno por empanada
// × 12 son ~780 g de plato, o sea el equivalente a un cuarto de la receta.
const RELLENOS = [
  ["empanadas-fritas-de-aji-de-gallina", 0.25],
  ["tequenos-de-aji-de-gallina", 0.2],
  ["empanadas-de-lomo-saltado", 0.25],
  ["spring-rolls-de-lomo-saltado", 0.2],
];
for (const [slug, factor] of RELLENOS) {
  const r = receta(slug);
  if (!r) continue;
  if (!Array.isArray(r.nested) || r.nested.length === 0) {
    fallas.push(`${slug}: esperaba una receta anidada y no tiene`);
    continue;
  }
  const antes = r.nested[0].servingsFactor;
  r.nested[0].servingsFactor = factor;
  hechos.push(`${slug}: anidado ${antes} → ${factor} (solo el relleno, sin arroz ni guarnición)`);
}

// ═════════════════════════════════════════════ 4 · FÍSICA QUE NO DABA
//
// arrollado primavera: 250 g de harina repartidos en 8 láminas dan 2 mm de
// espesor. Un envoltorio de arrollado va entre 0,3 y 0,5 mm — con 2 mm no se
// fríe crocante, se queda crudo por dentro. Se baja la harina manteniendo los
// ocho arrollados.
for (const slug of ["arrollado-primavera", "arrollado-de-jamon-y-queso-frito"]) {
  componente(slug, "harina de trigo", {
    quantity: 120,
    minQuantity: 100,
    maxQuantity: 140,
    notes: "para ocho láminas finísimas: con más harina el envoltorio queda grueso y no fríe crocante",
  });
  const r = receta(slug);
  if (r) {
    const i = r.steps.findIndex((p) => /estira|uslere/i.test(p.instruction));
    if (i === -1) fallas.push(`${slug}: no encontré el paso de estirar`);
    else if (!r.steps[i].instruction.includes("casi transparente")) {
      r.steps[i].instruction +=
        " Estírala hasta dejarla casi transparente: si la lámina se ve opaca, todavía está gruesa.";
      hechos.push(`${slug}: el paso de estirar dice hasta dónde`);
    }
  }
}

// cazuela-de-ave-nogada — era la cazuela de pollo ya publicada, gramo por
// gramo, con 60 g de nueces encima: 15 g por plato no se ven ni se sienten, así
// que la "diferencia culinaria que tiene que notarse" no existía. La nogada de
// verdad es un caldo cremoso y color madera.
componente("cazuela-de-ave-nogada", "nueces", {
  quantity: 110,
  minQuantity: 90,
  maxQuantity: 130,
  notes: "molidas hasta pasta: son las que dan el color madera y la cremosidad, no un adorno encima",
});
{
  const r = receta("cazuela-de-ave-nogada");
  if (r) {
    const antes = r.components.length;
    r.components = r.components.filter((c) => c.ingredient !== "cilantro");
    if (r.components.length === antes) fallas.push("cazuela-de-ave-nogada: no tenía cilantro que sacar");
    else hechos.push("cazuela-de-ave-nogada: fuera el cilantro (la nogada colchagüina no lo lleva)");
    if (!r.description.includes("nogada")) {
      fallas.push("cazuela-de-ave-nogada: la descripción no habla de la nogada");
    }
  }
}

// pescado-a-lo-macho — colisionaba con la publicada "Pescado con salsa de
// mariscos": los dos son filete blanco bañado en salsa cremosa de mariscos. La
// diferencia culinaria SÍ existe y es verificable; lo que faltaba era decirla.
{
  const r = receta("pescado-a-lo-macho");
  if (r && !r.description.includes("a diferencia")) {
    r.description +=
      " A diferencia del pescado con salsa de mariscos chileno, acá el filete se enharina y se fríe antes de bañarlo, y la salsa se hace con ají amarillo y leche evaporada ligada con maicena: sale anaranjada y espesa, no blanca.";
    hechos.push("pescado-a-lo-macho: la descripción declara la diferencia contra la publicada");
  }
}

// ═══════════════════════════════════════════════════════════════ cierre
if (fallas.length) {
  console.error("\nCORRECCIONES QUE NO SE PUDIERON APLICAR:\n");
  for (const f of fallas) console.error("  ✗ " + f);
  console.error("\nNo se escribió nada.\n");
  process.exitCode = 1;
} else {
  writeFileSync(archivo, JSON.stringify(datos, null, 2));
  console.log(`${hechos.length} correcciones aplicadas sobre ${recetas.length} recetas:\n`);
  for (const h of hechos) console.log("  · " + h);
}
