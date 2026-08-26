#!/usr/bin/env node
/** Correcciones al LOTE E según los tres verificadores. */
import { readFileSync, writeFileSync } from "node:fs";
const RUTA = ".plan/lote-e-recetas.json";
const recetas = JSON.parse(readFileSync(RUTA, "utf8"));
const cambios = [];
const receta = (s) => { const r = recetas.find((x) => x.slug === s); if (!r) throw new Error("no existe " + s); return r; };
const anota = (t) => cambios.push(t);

// ── ALTO · el cochayuyo no es una proteína ────────────────────────────────
{
  const r = receta("cochayuyo-guisado-con-papas");
  const c = r.components.find((x) => x.ingredient === "cochayuyo");
  c.slot = "VEGETABLE";
  c.notes = `${c.notes ?? ""} Es un alga: aporta minerales y fibra, no proteína comparable a una carne o una legumbre.`.trim();
  r.description = r.description
    .replace(/rinde como si fuera carne y sostiene el almuerzo sin carne ni legumbre al lado/i,
             "es el guiso barato de la costa, y la papa es la que sostiene el plato")
    .replace(/reemplaza a la carne/gi, "acompaña a la papa");
  anota("cochayuyo: sale del slot PROTEIN (es un alga, no una fuente proteica) y la descripción deja de prometer que reemplaza a la carne. Un plato sin proteína declarado como si la tuviera engaña al motor y a quien lo cocina");
}

// ── ALTO · el mote con huesillo no declaraba cuánta agua lleva ────────────
{
  const r = receta("mote-con-huesillo");
  const p = r.steps.find((x) => /remojo/i.test(x.instruction) && /olla|cuece|hierv/i.test(x.instruction))
         ?? r.steps[1];
  p.instruction = p.instruction.replace(/$/, " Agrega el agua del remojo más agua limpia hasta completar unos dos litros: el mote con huesillo se toma, no se come con cuchara seca.");
  anota("mote con huesillo: ningún paso decía cuánta agua lleva el jugo. Sin volumen declarado, el motor reparte 240 g de huesillos en un líquido que no existe");
}

// ── ALTO · dos kilos de choritos no son un almuerzo ──────────────────────
{
  const r = receta("choritos-al-vapor-con-limon");
  r.mealTypes = ["SNACK", "TEA"];
  r.description = r.description.replace(/$/, " Es entrada o picoteo de verano, no un almuerzo completo: si lo comen como plato principal, va con papas cocidas o pan al lado.");
  anota("choritos al vapor: estaba declarado LUNCH/DINNER sin ningún carbohidrato. Con el factor de concha, cada persona recibe ~150 g de carne y nada más. Pasa a SNACK/TEA, que es lo que realmente es");
}

// ── ALTO · el milcao declaraba papa dos veces en el mismo slot ───────────
{
  const r = receta("milcao");
  const papas = r.components.filter((x) => x.ingredient === "papa");
  const cocida = papas.find((x) => x.cookingMethod === "BOILED");
  cocida.slot = "BASE";
  cocida.notes = `${cocida.notes ?? ""} Va en slot BASE, no en CARBOHYDRATE: es el ligante de la masa, no la porción de carbohidrato del plato.`.trim();
  anota("milcao: declaraba `papa` DOS VECES en el mismo slot con el mismo rol — la rallada cruda y la cocida molida. El motor las habría sumado o pisado. La cocida pasa a BASE, que es lo que de verdad hace: amarrar la masa");
}

// ── ALTO · el factor de la receta anidada era de porciones, no de peso ───
{
  const r = receta("sopaipillas-pasadas");
  const n = r.nested.find((x) => x.slug === "sopaipillas");
  n.servingsFactor = 3;
  anota("sopaipillas pasadas: pedía 1,5 tandas de sopaipillas para 6 porciones, cuando la receta anidada rinde 2. Sube a 3 (6 ÷ 2), que da las 3-4 sopaipillas por plato que promete el paso final");
}

writeFileSync(RUTA, JSON.stringify(recetas, null, 2), "utf8");
console.log(`${cambios.length} correcciones aplicadas:\n`);
for (const c of cambios) console.log(`  · ${c}`);
