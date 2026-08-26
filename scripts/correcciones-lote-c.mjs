#!/usr/bin/env node
/**
 * Correcciones al LOTE C según los tres verificadores.
 *
 * El contrato endurecido después del LOTE B se notó: cero problemas de base
 * física, de identidad y de unidad. Lo que quedó son errores de COCINA y de
 * coherencia interna, que es exactamente lo que uno quiere que sobreviva a un
 * contrato: lo que ninguna regla mecánica puede atrapar.
 */

import { readFileSync, writeFileSync } from "node:fs";

const RUTA = ".plan/lote-c-recetas.json";
const recetas = JSON.parse(readFileSync(RUTA, "utf8"));
const cambios = [];
const receta = (s) => {
  const r = recetas.find((x) => x.slug === s);
  if (!r) throw new Error(`no existe ${s}`);
  return r;
};
const paso = (slug, pred) => {
  const p = receta(slug).steps.find(pred);
  if (!p) throw new Error(`${slug}: no encontré el paso`);
  return p;
};
const comp = (slug, ing) => {
  const c = receta(slug).components.find((x) => x.ingredient === ing);
  if (!c) throw new Error(`${slug}: no tiene ${ing}`);
  return c;
};
const anota = (t) => cambios.push(t);

// ── BLOQUEANTE · el caldo servía 175 g de pollo por persona que no estaban ──
{
  const r = receta("caldo-de-pollo-casero");
  r.steps.push({
    instruction:
      "Devuelve la carne desmenuzada al caldo colado y calienta un minuto antes de servir. Si la vas a guardar para otra preparación, sirve el caldo solo y anota que ese plato ya no lleva la proteína.",
    minutes: 2,
  });
  const p = r.steps.find((x) => /gu[aá]rdala aparte/i.test(x.instruction));
  if (p) {
    p.instruction = p.instruction.replace(
      /gu[aá]rdala aparte[^.]*\./i,
      "deshuésala y desmenúzala mientras el caldo se cuela.",
    );
  }
  anota(
    "caldo-de-pollo-casero [BLOQUEANTE]: la carne volvía a ninguna parte. La receta declaraba 1 kg de trutro repartido en 4 porciones y servía caldo colado: el sistema atribuía ~175 g de pollo por persona a un plato que no los tenía. Ahora la carne vuelve al caldo en un paso explícito",
  );
}

// ── ALTO · dos tandas de presas con hueso no caben en 22 minutos ───────────
{
  const p = paso("pollo-frito-con-papas-fritas", (x) => /Fríe las presas/i.test(x.instruction));
  p.minutes = 32;
  p.instruction = p.instruction.replace(
    "Fríe las presas de a poco, sin amontonarlas, dándolas vuelta,",
    "Fríe las presas en dos tandas, unos 15 minutos cada una, sin amontonarlas y dándolas vuelta a la mitad,",
  );
  receta("pollo-frito-con-papas-fritas").cookMinutes = 46;
  anota("pollo-frito: la fritura pasa de 22 a 32 min (dos tandas de 15). Con 22 el pollo con hueso queda crudo pegado al hueso. cookMinutes 36→46");
}

// ── ALTO · el paso de la olla a presión no decía qué hacer ─────────────────
{
  const p = paso("garbanzos-con-longaniza", (x) => x.optionalCapability === "PRESSURE_COOKER");
  p.instruction =
    "En vez de la olla común: cierra los garbanzos remojados en la olla a presión con agua nueva sin sal, hasta cubrirlos dos dedos, y cuenta los minutos desde que toma presión. Deja bajar la presión sola antes de abrir.";
  anota('garbanzos-con-longaniza: el paso de olla a presión decía solo "Acorta la cocción de los garbanzos" — sin método y sin decir qué paso reemplaza. Ahora está redactado como sustitución');
}

// ── ALTO · el tiempo se tomó del miembro corto del grupo paralelo ──────────
{
  const r = receta("zapallo-italiano-guisado-con-carne-molida");
  r.cookMinutes = 38;
  r.tags = r.tags.filter((t) => t !== "RAPIDA");
  const choclo = comp("zapallo-italiano-guisado-con-carne-molida", "choclo en grano");
  choclo.quantity = 150;
  if (choclo.maxQuantity && choclo.maxQuantity < 150) choclo.maxQuantity = 200;
  const tomate = comp("zapallo-italiano-guisado-con-carne-molida", "tomate");
  tomate.quantity = 250;
  anota("zapallo italiano guisado: cookMinutes tomaba los 15 min del zapallo en vez de los 18 del arroz que corre en el mismo grupo. 35→38, y fuera RAPIDA (48 min en total). Además baja el choclo a 150 g y el tomate a 250 g para que no sea un tomaticán con zapallo");
}

// ── MEDIO · tiempos que no alcanzan para lo que el paso pide ───────────────
{
  const p = paso("carbonada", (x) => /arroz/i.test(x.instruction));
  p.minutes = 16;
  receta("carbonada").cookMinutes = 56;
  anota("carbonada: el arroz crudo tenía 10 min en el caldo y necesita 15-16. 50→56 de cocción");
}
{
  const p = paso("empanadas-de-pino-al-horno", (x) => /vaso de agua|jugo|hervor/i.test(x.instruction) && x.minutes === 10);
  if (p) { p.minutes = 19; receta("empanadas-de-pino-al-horno").cookMinutes = 63; }
  const discos = paso("empanadas-de-pino-al-horno", (x) => /disco/i.test(x.instruction));
  discos.instruction = discos.instruction.replace(/18 cm/g, "20 cm").replace(
    /$/,
    " Deja dos centímetros de borde limpio para el doblez: si el pino llega al filo, la empanada se abre en el horno.",
  );
  anota("empanadas: el pino tenía 10 min para reducir el agua de 800 g de cebolla (quedaba aguado y abría la empanada) → 19 min. Y los discos pasan de 18 a 20 cm, que es la medida de la empanada de horno chilena");
}
{
  const p = paso("pan-amasado", (x) => /agua tibia/i.test(x.instruction));
  p.instruction = p.instruction.replace(
    /100 ml|un vaso de agua tibia/i,
    "unos 125 ml de agua tibia de a poco, hasta juntar una masa blanda que no se pegue en las manos (la cantidad final depende de la harina)",
  );
  const agua = receta("pan-amasado").components.find((c) => /agua/i.test(c.ingredient));
  if (agua) agua.quantity = 125;
  anota("pan-amasado: 100 ml para 250 g de harina es 40 % de hidratación y la masa queda dura; sube a ~125 ml");
}
{
  const p = paso("chupe-de-pescado", (x) => /merluza/i.test(x.instruction) && x.minutes === 8);
  if (p) {
    p.minutes = 5;
    p.instruction = p.instruction.replace(
      /$/,
      " Apenas la carne se separe en láminas, apágala y sácala del agua: se termina de cocinar dentro del chupe.",
    );
    anota("chupe-de-pescado: la merluza tenía 8 min y se separa en láminas a los 4-5. Se pasaba y después el paso 6 pedía que no se deshiciera");
  }
}
{
  receta("salmon-al-horno-con-papas").cookMinutes = 50;
  anota("salmon-al-horno: el precalentado no estaba sumado mientras que en pollo-al-horno del mismo lote sí. Criterio unificado: cuenta. 40→50");
}

// ── MEDIO · la regla 8 también vale dentro de los pasos ────────────────────
{
  const r = receta("pollo-al-horno-con-tomate-y-cebolla");
  if (r.batchPrepNotes) {
    r.batchPrepNotes = r.batchPrepNotes.replace(/desde la noche anterior/gi, "con anticipación");
    anota("pollo-al-horno-con-tomate: la nota de lote daba una ventana de conservación de pollo crudo ('desde la noche anterior'). Los plazos los pone el motor de seguridad, no la receta");
  }
}
{
  const p = receta("costillar-de-cerdo-al-horno-con-papas").steps.find((x) => /refrigerador/i.test(x.instruction));
  if (p) {
    p.instruction = p.instruction.replace(
      /mientras más rato,? mejor queda/i,
      "mientras más rato tome el adobo, mejor queda el sabor",
    );
    anota("costillar: el paso invitaba a un reposo indefinido de cerdo crudo ('mientras más rato, mejor'). Reescrito sin ventana abierta");
  }
  const q = receta("empanadas-de-pino-al-horno").steps.find((x) => /el día anterior/i.test(x.instruction));
  if (q) {
    q.instruction = q.instruction.replace(/el día anterior/i, "con anticipación");
    anota("empanadas: mismo caso, el pino decía 'hazlo el día anterior'");
  }
}
{
  const r = receta("caldo-de-pollo-casero");
  if (r.batchPrepNotes) {
    r.batchPrepNotes = r.batchPrepNotes.replace(/\s*si alguien la tiene restringida\.?/i, ".");
    anota("caldo-de-pollo: la nota prometía un beneficio clínico ('si alguien la tiene restringida') que el motor no ve, porque los componentes siguen declarando la piel. La compatibilidad clínica la resuelve el motor con los datos, no una nota");
  }
}

// ── MEDIO/BAJO · roles y slots ────────────────────────────────────────────
{
  const c = comp("panqueques-con-manjar", "azucar granulada");
  c.role = "MAIN";
  anota("panqueques: el azúcar va disuelta DENTRO de la masa y se come entera, así que es comida (MAIN), no un espolvoreo (SEASONING). Como SEASONING el optimizador la trataba como intocable");
}
{
  const c = comp("huevos-revueltos-con-pan", "leche liquida entera");
  c.slot = "BASE";
  anota("huevos-revueltos: la leche estaba en slot OTHER, el cajón de sal y especias. En las otras cuatro recetas del lote que la usan va en BASE");
}
{
  const c = comp("empanadas-de-pino-al-horno", "pasas");
  c.optional = true;
  c.adjustability = "OPTIONAL";
  anota("empanadas: las pasas decían en su nota que son prescindibles pero estaban declaradas ADJUSTABLE con min 0. Ahora son OPTIONAL de verdad y la interfaz puede ofrecer sacarlas");
}
{
  // La ruta air fryer come mucho menos aceite que la sartén: el mínimo tiene
  // que poder representarla, porque ADDED_FAT es lo único que el optimizador mueve.
  for (const [slug, minimo] of [["reineta-apanada-con-pure", 15], ["pollo-frito-con-papas-fritas", 25]]) {
    const c = comp(slug, "aceite vegetal");
    c.minQuantity = minimo;
    c.notes = `${c.notes ?? ""} Si lo haces en air fryer, el aceite que se come es solo el del pincel: por eso el mínimo baja tanto.`.trim();
  }
  anota("reineta apanada y pollo frito: el mínimo de aceite no alcanzaba a representar la ruta air fryer, así que quien cocinara así recibía ~35 ml de aceite fantasma");
}

// ── BAJO · pasos de picado que nadie declaraba ────────────────────────────
{
  const r = receta("garbanzos-con-longaniza");
  const i = r.steps.findIndex((x) => x.optionalCapability === "PRESSURE_COOKER");
  r.steps.splice(i + 1, 0, {
    instruction:
      "Mientras los garbanzos se cuecen, pica la cebolla, el pimiento y el ajo finos y el tomate en cubos. Es lo que el sofrito da por hecho y toma su rato.",
    minutes: 10,
    parallelGroup: 1,
  });
  const cocer = r.steps.find((x) => x.minutes === 60);
  if (cocer) cocer.parallelGroup = 1;
  anota("garbanzos-con-longaniza: faltaba el paso de picado (250 g de cebolla, 150 de pimiento y 350 de tomate no se pican solos). Va en paralelo con la cocción");
}
{
  const r = receta("costillar-de-cerdo-al-horno-con-papas");
  const i = r.steps.findIndex((x) => /horno/i.test(x.instruction) && x.temperatureC);
  r.steps.splice(Math.max(i, 1), 0, {
    instruction: "Mientras el costillar toma su primer tramo de horno, pela las papas y córtalas en gajos gruesos.",
    minutes: 8,
    parallelGroup: 2,
  });
  anota("costillar: no había paso para pelar y cortar 900 g de papa; el horneado ya estaba a 200 °C y las daba por listas");
}

writeFileSync(RUTA, JSON.stringify(recetas, null, 2), "utf8");
console.log(`${cambios.length} correcciones aplicadas:\n`);
for (const c of cambios) console.log(`  · ${c}`);
