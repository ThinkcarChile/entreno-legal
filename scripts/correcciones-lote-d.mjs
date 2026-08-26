#!/usr/bin/env node
/** Correcciones al LOTE D según los tres verificadores. */

import { readFileSync, writeFileSync } from "node:fs";

const RUTA = ".plan/lote-d-recetas.json";
const recetas = JSON.parse(readFileSync(RUTA, "utf8"));
const cambios = [];
const receta = (s) => {
  const r = recetas.find((x) => x.slug === s);
  if (!r) throw new Error(`no existe ${s}`);
  return r;
};
const comp = (slug, ing) => {
  const c = receta(slug).components.find((x) => x.ingredient === ing);
  if (!c) throw new Error(`${slug}: no tiene ${ing}`);
  return c;
};
const anota = (t) => cambios.push(t);

// ── BLOQUEANTE · el ceviche no tenía jugo para cubrir el pescado ───────────
{
  const c = comp("ceviche-de-reineta", "limon");
  c.quantity = 750; c.minQuantity = 600; c.maxQuantity = 1000;
  c.notes =
    "peso del limón ENTERO, que es lo que se compra: 750 g rinden unos 280 ml de jugo, lo justo para cubrir 700 g de pescado. Con menos, el pescado se marina por arriba y queda crudo abajo.";
  anota("ceviche [BLOQUEANTE]: 200 g de limón entero rinden ~75 ml de jugo y el paso exige cubrir 700 g de pescado. Sube a 750 g (min 600, max 1000): aproximadamente 1 g de limón por gramo de pescado");
}

// ── BLOQUEANTE · un paso de sustitución no puede ir en un grupo paralelo ───
{
  for (const slug of recetas.map((r) => r.slug)) {
    for (const p of receta(slug).steps) {
      if (p.optionalCapability && p.parallelGroup !== undefined) {
        delete p.parallelGroup;
        anota(`${slug} [BLOQUEANTE]: el paso de ${p.optionalCapability} llevaba parallelGroup. Un paso con capacidad SUSTITUYE a otro, no corre junto a él — y encima era un grupo de un solo miembro`);
      }
    }
  }
}

// ── ALTO · la receta decía que la verdura se come y el paso la colaba ──────
{
  const r = receta("pollo-cocido-desmenuzado");
  const p = r.steps.find((x) => /cuela el caldo/i.test(x.instruction));
  if (p) {
    p.instruction = p.instruction.replace(
      /Cuela el caldo y gu[aá]rdalo aparte/i,
      "Saca la cebolla y la zanahoria con una espumadera y déjalas junto a la carne desmenuzada — se comen, no se botan. Cuela el caldo y guárdalo aparte",
    );
    anota("pollo-cocido-desmenuzado: las verduras decían en su nota 'se comen con el caldo' y el paso las colaba y botaba. Ahora se rescatan con espumadera antes de colar");
  }
}

// ── ALTO · sodio que nadie se come ────────────────────────────────────────
{
  const c = comp("humitas", "sal");
  c.quantity = 5; c.minQuantity = 0; c.maxQuantity = 7;
  c.notes = "solo la sal de la MASA. El agua de hervor se sala aparte y se bota: esa sal no se come y no se declara.";
  const p = receta("humitas").steps.find((x) => /hervir|hervor|olla/i.test(x.instruction));
  if (p) p.instruction = p.instruction.replace(/$/, " El agua de la olla va salada, pero esa sal se queda ahí.");
  anota("humitas: la sal declaraba 'la de la masa y la del agua de hervor'. El agua se bota, así que eran ~3 g de sodio fantasma en un plato que ya es salado. 8→5 g");
}

// ── ALTO · 600 g de arvejas desgranadas no aparecen solas ─────────────────
{
  const r = receta("arvejas-frescas-guisadas-con-huevo");
  r.steps.unshift({
    instruction:
      "Desgrana las arvejas apretando la vaina por la costura. 600 g desgranados salen de más o menos kilo y medio con vaina, y toma su rato: aprovecha de picar la cebolla y la zanahoria mientras tanto.",
    minutes: 40,
  });
  r.prepMinutes = 45;
  anota("arvejas guisadas: faltaba el desgrane. 600 g desgranados salen de ~1,5 kg con vaina y toman 40 minutos que no estaban declarados en ninguna parte (prepMinutes 20→45)");
}

// ── ALTO · el queque llevaba el doble de polvos de hornear ────────────────
{
  const c = comp("queque-casero-de-naranja", "polvos de hornear");
  c.quantity = 9;
  anota("queque de naranja: 12 g de polvos para 280 g de harina es el doble de lo normal, y con el jugo ácido reaccionando el queque sube y se desploma. 12→9 g");
}

// ── ALTO · dos recetas se llamaban por el método que era opcional ─────────
{
  const r = receta("pollo-a-la-parrilla-con-ensalada-chilena");
  r.slug = "pollo-adobado-al-horno-con-ensalada-chilena";
  r.name = "Pollo adobado al horno con ensalada chilena";
  r.description =
    "Trutros adobados con ajo, ají de color y limón, horneados hasta que la piel queda tostada, con ensalada chilena al lado. Si tienes parrilla, el mismo adobo va al fuego y queda mejor todavía.";
  anota('pollo a la parrilla → "Pollo adobado al horno con ensalada chilena": el método base era el horno y la parrilla es el paso opcional. Quien no tiene parrilla —la mayoría— recibía un plato que no se parecía a su nombre');
}
{
  const r = receta("anticuchos-a-la-parrilla");
  r.slug = "anticuchos-de-posta";
  r.name = "Anticuchos de posta con cebolla y pimiento";
  r.description =
    "Cubos de posta ensartados con cebolla y pimiento, dorados a la plancha o a la parrilla. En el palo van bien apretados: es lo que hace que la carne se dore por fuera y quede jugosa adentro.";
  anota('anticuchos a la parrilla → "Anticuchos de posta con cebolla y pimiento": el método base es la plancha, y llamarlo "a la parrilla" prometía algo que la receta por defecto no entrega');
}

// ── ALTO · con baño maría a 160 °C eso es un flan, no una leche asada ─────
{
  const r = receta("leche-asada");
  const p1 = r.steps.find((x) => /baño maría/i.test(x.instruction) && x.temperatureC === 160);
  if (p1) {
    p1.instruction = "Enciende el horno a 180 °C.";
    p1.temperatureC = 180;
    p1.minutes = 5;
  }
  const p5 = r.steps.find((x) => /Hornea/i.test(x.instruction));
  if (p5) {
    p5.instruction =
      "Hornea DIRECTO, sin baño maría, hasta que la superficie esté dorada y ampollada y el centro cuajado. Esa cara tostada es lo que la hace leche asada y no un flan: el baño maría la dejaría pálida y lisa.";
    p5.temperatureC = 180;
    p5.minutes = 50;
  }
  const caramelo = r.steps.find((x) => /caramelo|Derrite/i.test(x.instruction));
  if (caramelo) {
    caramelo.instruction = caramelo.instruction.replace(
      /^/,
      "Opcional, si te gusta con caramelo abajo: ",
    );
  }
  anota("leche asada: estaba horneada a baño maría a 160 °C hasta que el centro temblara, que es la receta de un FLAN. La leche asada chilena va directo al horno a 180 °C hasta que la superficie se dora y se ampolla. El caramelo pasa a ser opcional");
}

// ── ALTO · el reloj no contaba el enfriado ────────────────────────────────
{
  const r = receta("ensalada-rusa");
  const p = r.steps.find((x) => /fría|enfriar|completamente fr/i.test(x.instruction));
  if (p) {
    p.minutes = 60;
    p.instruction = p.instruction.replace(
      /$/,
      " Extendida en una fuente plana enfría bastante más rápido que amontonada en la olla.",
    );
  }
  r.prepMinutes = 80;
  anota("ensalada rusa: el paso de enfriar no declaraba minutos y enfriar 850 g de papa recién cocida toma más de una hora. El encabezado prometía 50 minutos totales para un plato que no está listo hasta dos horas después (prepMinutes 20→80)");
}

writeFileSync(RUTA, JSON.stringify(recetas, null, 2), "utf8");
console.log(`${cambios.length} correcciones aplicadas:\n`);
for (const c of cambios) console.log(`  · ${c}`);
