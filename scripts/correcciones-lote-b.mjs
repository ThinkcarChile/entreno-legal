#!/usr/bin/env node
/**
 * Correcciones al LOTE B a partir de los hallazgos de los tres verificadores.
 *
 * Cada cambio lleva el hallazgo que lo motiva. Se aplican como script y no a
 * mano para que quede el registro de QUÉ se cambió y POR QUÉ, y para poder
 * repetirlo si hay que regenerar el lote.
 *
 * Lo que NO se hizo: bajar tiempos declarados para que una etiqueta calce. Si
 * una receta tarda 55 minutos, se le saca la etiqueta RAPIDA; no se le miente
 * al reloj.
 */

import { readFileSync, writeFileSync } from "node:fs";

const RUTA = ".plan/lote-b-recetas.json";
const recetas = JSON.parse(readFileSync(RUTA, "utf8"));
const cambios = [];

const receta = (slug) => {
  const r = recetas.find((x) => x.slug === slug);
  if (!r) throw new Error(`no existe la receta ${slug}`);
  return r;
};
const comp = (slug, ingrediente) => {
  const c = receta(slug).components.find((x) => x.ingredient === ingrediente);
  if (!c) throw new Error(`${slug} no tiene el componente ${ingrediente}`);
  return c;
};
const anota = (t) => cambios.push(t);

// ── ALTO/BLOQUEANTE · la etiqueta RAPIDA tiene que ser verdad ────────────────
for (const slug of ["escalopas-de-pollo-apanadas-con-pure"]) {
  const r = receta(slug);
  r.tags = r.tags.filter((t) => t !== "RAPIDA");
  anota(`${slug}: fuera la etiqueta RAPIDA (25+30 = 55 min; apanar y freír de a tandas no es rápido)`);
}
{
  const r = receta("tallarines-con-salsa-de-tomate");
  r.tags = r.tags.filter((t) => t !== "RAPIDA");
  r.cookMinutes = 42;
  anota("tallarines-con-salsa-de-tomate: cookMinutes 33→42 para que cuadre con los pasos, y fuera RAPIDA (una salsa larga de 25 min no lo es)");
}

// ── ALTO · el aceite declarado es el que SE COME, no el baño de la sartén ────
// Criterio unificado con el LOTE A (merluza frita: 60 ML) y con las sopaipillas
// del propio lote. Lo declarado se suma entero al plato: declarar el baño
// completo carga ~340 kcal por persona que nadie se comió.
{
  const c = comp("bistec-a-lo-pobre", "aceite vegetal");
  c.quantity = 65; c.minQuantity = 40; c.maxQuantity = 100;
  c.notes = "aceite RETENIDO por las papas y la carne, no el baño de la sartén (en la olla van 250 ml o más y casi todo queda). Cuánto se absorbe de verdad es desconocido.";
  anota("bistec-a-lo-pobre: aceite 150→65 ML (max 250→100). Se declara el retenido, no el baño");
}
{
  const c = comp("escalopas-de-pollo-apanadas-con-pure", "aceite vegetal");
  c.quantity = 55; c.minQuantity = 35; c.maxQuantity = 80;
  c.notes = "aceite RETENIDO por el apanado, no el de la sartén. En la sartén van 200 ml o más; lo que se absorbe es una fracción y no se conoce con precisión.";
  anota("escalopas: aceite 80→55 ML (max 120→80), mismo criterio");
}

// ── MEDIO · el apanado que sobra en el plato no se come ─────────────────────
{
  const p = comp("escalopas-de-pollo-apanadas-con-pure", "pan rallado");
  p.quantity = 90; p.minQuantity = 70; p.maxQuantity = 120;
  p.notes = "lo que de verdad se adhiere a la carne. En el plato del apanado se pone bastante más y ese resto se bota.";
  const h = comp("escalopas-de-pollo-apanadas-con-pure", "harina de trigo");
  h.quantity = 40; h.minQuantity = 30; h.maxQuantity = 55;
  h.notes = "primera capa del apanado: se declara la que queda pegada, no la del plato.";
  anota("escalopas: pan rallado 140→90 g y harina 60→40 g (se declara lo que se adhiere, igual que con el aceite)");
}

// ── ALTO (seguridad) · el trutro con hueso necesita más fuego ────────────────
{
  const r = receta("arroz-con-pollo");
  const p = r.steps[3];
  p.minutes = 26;
  p.instruction =
    "Vuelve a poner el pollo encima y cubre con agua caliente: el doble de volumen que el arroz. Tapa y deja hervir suave sin revolver, hasta que la carne se separe del hueso sin esfuerzo y el jugo salga claro al pincharla.";
  r.cookMinutes = 48;
  anota("arroz-con-pollo: hervor 18→26 min con señal de punto ('se separa del hueso, jugo claro'). Con 18 min el trutro entero queda crudo pegado al hueso. cookMinutes 40→48");
}

// ── ALTO · el atún se agregaba y después seguía 13 min al fuego ─────────────
{
  const r = receta("fideos-con-atun");
  const atun = r.steps[3];
  const orden = [r.steps[0], r.steps[1], r.steps[2], r.steps[4], r.steps[5], atun];
  atun.instruction =
    "Fuera del fuego, escurre bien el atún, desmenúzalo y revuélvelo con los fideos ya salseados. Solo se entibia: si hierve se pone seco y harinoso.";
  atun.minutes = 2;
  r.steps = orden;
  const t = comp("fideos-con-atun", "tomate");
  t.slot = "SAUCE";
  for (const a of r.alternatives ?? []) if (a.ingredient === "salsa de tomate envasada") a.slot = "SAUCE";
  anota("fideos-con-atun: el atún pasa al último paso, fuera del fuego (antes entraba y seguía 13 min en la olla, justo lo que la receta advierte). El tomate pasa a slot SAUCE, como en las otras dos salsas del lote");
}

// ── ALTO · el paso del equipo opcional iba después de servir el plato ───────
const moverCapacidad = (slug, desde, hastaDespuesDe, texto) => {
  const r = receta(slug);
  const [paso] = r.steps.splice(desde, 1);
  paso.instruction = texto;
  r.steps.splice(hastaDespuesDe, 0, paso);
  anota(`${slug}: el paso de ${paso.optionalCapability} se mueve a su lugar (antes iba después de armar el plato: quien siguiera la receta cocinaba dos veces)`);
};
moverCapacidad(
  "escalopas-de-pollo-apanadas-con-pure", 6, 4,
  "En vez de freír en sartén: dora las escalopas en la air fryer, dándolas vuelta a la mitad, hasta que el apanado esté firme y tostado.",
);
moverCapacidad(
  "bistec-a-lo-pobre", 6, 2,
  "En vez de freír las papas en aceite: dóralas en la air fryer, moviendo la canasta un par de veces, hasta que estén crujientes.",
);

// ── ALTO · una alternativa que el motor no puede ejecutar ───────────────────
{
  const r = receta("huevo-a-la-copa-con-marraqueta");
  const antes = (r.alternatives ?? []).length;
  r.alternatives = (r.alternatives ?? []).filter((a) => a.ingredient !== "harina de trigo");
  if (r.alternatives.length === 0) delete r.alternatives;
  anota(`huevo-a-la-copa-con-marraqueta: fuera la alternativa "harina de trigo" para el pan (${antes} → ${r.alternatives?.length ?? 0}). Nadie moja harina cruda en la yema, y el motor la convertiría en "2 unidades de harina"`);
}

// ── MEDIO · alternativas que apuntan al mismo ingrediente que reemplazan ────
for (const [slug, ing] of [
  ["sandwich-de-ave-palta", "pan marraqueta"],
  ["pantrucas", "papa"],
  ["sopaipillas", "aceite vegetal"],
]) {
  const r = receta(slug);
  const antes = (r.alternatives ?? []).length;
  r.alternatives = (r.alternatives ?? []).filter((a) => a.ingredient !== ing);
  if (r.alternatives.length === 0) delete r.alternatives;
  if (antes !== (r.alternatives?.length ?? 0)) {
    anota(`${slug}: fuera la alternativa "${ing}" — ya es componente de la misma receta, así que sustituirlo por sí mismo deja el slot duplicado`);
  }
}

// ── MEDIO · dos recetas del lote se disputaban el nombre "surtida" ──────────
{
  const r = receta("pechuga-a-la-plancha-con-ensalada-surtida");
  r.slug = "pechuga-a-la-plancha-con-dos-ensaladas";
  r.name = "Pechuga a la plancha con dos ensaladas";
  r.description =
    "Pechuga aliñada con ajo y limón, sellada en la plancha, con ensalada chilena y ensalada verde al lado. Cena liviana de quince minutos sin freír nada.";
  anota('pechuga: renombrada a "Pechuga a la plancha con dos ensaladas" — "surtida" es el nombre propio de la ensalada de papa, betarraga y huevo del mismo lote');
}

// ── MEDIO · la once se declara para 2, no para 4 ───────────────────────────
{
  const r = receta("sopaipillas");
  for (const c of r.components) {
    for (const k of ["quantity", "minQuantity", "maxQuantity"]) {
      if (typeof c[k] === "number") c[k] = Math.round(c[k] / 2 * 100) / 100;
    }
  }
  r.baseServings = 2;
  anota("sopaipillas: baseServings 4→2 con las cantidades a la mitad, para seguir la convención de once del LOTE A (baseServings es el divisor de toda la nutrición por persona)");

  // Y el tiempo declarado era el de la olla a presión, no el del método base.
  const base = r.steps[0];
  base.minutes = 40;
  base.instruction =
    "Pela el zapallo, sácale las pepas y cuécelo en poca agua hasta que se deshaga con el tenedor. Escúrrelo bien: si queda con agua, la masa pide más harina y las sopaipillas salen duras.";
  delete base.optionalCapability;
  delete base.manualAlternative;
  r.steps.splice(1, 0, {
    instruction: "En vez de los 40 minutos de olla común: cuece el zapallo en olla a presión hasta que ceda al tenedor.",
    minutes: 20,
    optionalCapability: "PRESSURE_COOKER",
    manualAlternative: "Sin olla a presión, el paso anterior es el camino: 40 minutos de olla común y a escurrir bien.",
  });
  r.cookMinutes = 45;
  anota("sopaipillas: el paso del zapallo declaraba los 20 min de la OLLA A PRESIÓN como si fueran el tiempo base. Ahora el paso base son 40 min de olla común y la olla a presión es un paso aparte, como en el LOTE A");
}

// ── MEDIO · el caldillo salaba solo al final y olvidaba el espinazo ─────────
{
  const r = receta("caldillo-de-merluza");
  r.steps[2].instruction =
    "Suma la papa en rodajas y cubre con agua caliente hasta pasar los ingredientes por dos dedos. Si compraste la merluza con espinazo, échalo ahora: es lo que le da cuerpo al caldo. Sala la mitad acá — si salas solo al final, la papa queda insípida por dentro.";
  r.steps.splice(3, 0, {
    instruction: "Saca el espinazo con una espumadera antes de poner el pescado.",
    minutes: 1,
  });
  r.steps[4].instruction =
    "Acomoda los trozos de merluza encima del caldo hirviendo, tapa y baja el fuego al mínimo: el pescado se cuece con el vapor y no se deshace.";
  r.steps[5].instruction =
    "Apaga, prueba y termina de salar, echa el orégano restregado entre las manos y el cilantro picado. Sirve con el limón en gajos.";
  r.cookMinutes = 38;
  anota("caldillo-de-merluza: el espinazo entra y sale en pasos reales (la nota lo pedía y ningún paso lo hacía), la sal se reparte en dos, cookMinutes 30→38");
}

// ── BAJO · grupos de paralelismo de un solo miembro no declaran nada ────────
for (const r of recetas) {
  const conteo = new Map();
  for (const p of r.steps) if (p.parallelGroup !== undefined) conteo.set(p.parallelGroup, (conteo.get(p.parallelGroup) ?? 0) + 1);
  for (const p of r.steps) {
    if (p.parallelGroup !== undefined && conteo.get(p.parallelGroup) === 1) {
      delete p.parallelGroup;
      anota(`${r.slug}: se quita un parallelGroup de un solo miembro (un grupo de uno no dice con qué corre en paralelo)`);
    }
  }
}
// Y en las escalopas, moler las papas DEPENDE de haberlas cocido: no van juntas.
{
  const r = receta("escalopas-de-pollo-apanadas-con-pure");
  const cocer = r.steps.find((p) => p.instruction.startsWith("Pon las papas"));
  const apanar = r.steps.find((p) => p.instruction.startsWith("Arma tres platos"));
  if (cocer && apanar) { cocer.parallelGroup = 1; apanar.parallelGroup = 1; anota("escalopas: cocer las papas corre en paralelo con apanar, no con molerlas (moler depende de cocer)"); }
}

// ── BAJO · tipeo y voz ──────────────────────────────────────────────────────
{
  const r = receta("bistec-a-lo-pobre");
  for (const p of r.steps) p.instruction = p.instruction.replace("sélllalos", "séllalos");
  anota("bistec-a-lo-pobre: tipeo 'sélllalos' → 'séllalos'");
}
{
  // El lote habla de tú a tú; estas tres recetas venían en infinitivo.
  const tuteo = [
    [/^Poner /, "Pon "], [/^Cocer /, "Cuece "], [/^Dejar /, "Deja "], [/^Pelar /, "Pela "],
    [/^Armar /, "Arma "], [/^Aliñar /, "Aliña "], [/^Desmenuzar /, "Desmenuza "],
    [/^Moler /, "Muele "], [/^Hacer /, "Haz "], [/^Cortar /, "Corta "], [/^Mezclar /, "Mezcla "],
    [/^Agregar /, "Agrega "], [/^Servir /, "Sirve "], [/^Repartir /, "Reparte "],
    [/^Batir /, "Bate "], [/^Sumar /, "Suma "], [/^Escurrir /, "Escurre "], [/^Untar /, "Unta "],
  ];
  let n = 0;
  for (const slug of ["sandwich-de-ave-palta", "ensalada-surtida-de-papa-betarraga-y-huevo", "pantrucas"]) {
    for (const p of receta(slug).steps) {
      for (const [de, a] of tuteo) {
        if (de.test(p.instruction)) { p.instruction = p.instruction.replace(de, a); n++; break; }
      }
    }
  }
  anota(`voz: ${n} pasos pasados de infinitivo a tuteo, para que todo el lote hable igual`);
}

writeFileSync(RUTA, JSON.stringify(recetas, null, 2), "utf8");
console.log(`${cambios.length} correcciones aplicadas:\n`);
for (const c of cambios) console.log(`  · ${c}`);
