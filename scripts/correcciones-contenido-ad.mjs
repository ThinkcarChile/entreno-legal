#!/usr/bin/env node
/**
 * Correcciones del lote A+D de la expansión de contenido (182 platos).
 *
 *   node scripts/correcciones-contenido-ad.mjs .plan/contenido/salida-AD.json
 *
 * Acá van las decisiones, no la mecánica: cada cambio corresponde a un hallazgo
 * del verificador de cocina, y queda escrito con su razón para que se pueda
 * discutir después. La mecánica (JSON → TypeScript) vive en `lote-desde-json`.
 *
 * REGLA DEL ARCHIVO: ningún parche puede fallar en silencio. Si el texto que
 * busca ya no está, o la receta no existe, el script REVIENTA sin escribir
 * nada. Una corrección que no se aplicó y nadie notó es peor que no haberla
 * escrito: queda el registro diciendo que el problema está resuelto y el plato
 * sigue malo.
 */

import { readFileSync, writeFileSync } from "node:fs";

const archivo = process.argv[2] ?? ".plan/contenido/salida-AD.json";
const datos = JSON.parse(readFileSync(archivo, "utf8"));
const recetas = datos.recetas;

const hechos = [];
const fallas = [];

const receta = (slug) => {
  const r = recetas.find((x) => x.slug === slug);
  if (!r) fallas.push(`${slug}: no existe en el lote`);
  return r;
};

/** Reemplaza texto en un paso. Falla si el texto buscado no está. */
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

/** Cambia los minutos de un paso. */
function minutos(slug, indice, valor) {
  const r = receta(slug);
  if (!r) return;
  const p = r.steps[indice - 1];
  if (!p) return fallas.push(`${slug}: no tiene paso ${indice}`);
  hechos.push(`${slug}/paso ${indice}: ${p.minutes ?? 0} → ${valor} min`);
  p.minutes = valor;
}

/** Cambia campos de la receta (tiempos, categoría, etiquetas). */
function campos(slug, cambios) {
  const r = receta(slug);
  if (!r) return;
  for (const [k, v] of Object.entries(cambios)) {
    hechos.push(`${slug}: ${k} ${JSON.stringify(r[k])} → ${JSON.stringify(v)}`);
    r[k] = v;
  }
}

/** Cambia campos de un componente, ubicándolo por nombre de alimento. */
function componente(slug, ingrediente, cambios, cual = 0) {
  const r = receta(slug);
  if (!r) return;
  const encontrados = r.components.filter((c) => c.ingredient === ingrediente);
  const c = encontrados[cual];
  if (!c) return fallas.push(`${slug}: no tiene componente «${ingrediente}»`);
  for (const [k, v] of Object.entries(cambios)) {
    if (v === null) delete c[k];
    else c[k] = v;
  }
  hechos.push(`${slug}/${ingrediente}: ${Object.keys(cambios).join(", ")}`);
}

/** Quita una etiqueta que dejó de ser verdad. */
function quitarEtiqueta(slug, etiqueta) {
  const r = receta(slug);
  if (!r) return;
  if (!r.tags?.includes(etiqueta)) return fallas.push(`${slug}: no tenía la etiqueta ${etiqueta}`);
  r.tags = r.tags.filter((t) => t !== etiqueta);
  hechos.push(`${slug}: fuera la etiqueta ${etiqueta}`);
}

/** Inserta un paso nuevo ANTES del índice dado (1-based). */
function insertarPaso(slug, indice, nuevo) {
  const r = receta(slug);
  if (!r) return;
  r.steps.splice(indice - 1, 0, nuevo);
  hechos.push(`${slug}: paso nuevo en posición ${indice}`);
}

// ═══════════════════════════════════════════════════════ 1 · BLOQUEANTES
//
// Dos platos que, escritos como estaban, NO SE PUEDEN COCINAR. No es que
// queden mejorables: uno da un batido líquido donde tiene que haber masa y el
// otro sale incomible.

// churros — masa escaldada 1:1. Con 500 ml de agua sobre 250 g de harina sale
// un batido que no se puede manguear con boquilla estrella y que jamás se va a
// "despegar solo de la olla" como dice el paso siguiente.
paso("churros", 1, "Hierve 500 ml de agua", "Hierve 250 ml de agua");

// chupe-de-locos — un loco sin aporrear y con 25 minutos de hervor queda como
// goma. La propia biblioteca lo desmiente: locos-mayo exige mazo y 45 minutos.
insertarPaso("chupe-de-locos", 1, {
  instruction:
    "Si los locos vienen crudos, envuélvelos de a uno en un paño y golpéalos con el mazo hasta que el músculo ceda. Sin este paso quedan como goma y no hay hervor que los arregle.",
  minutes: 10,
});
paso(
  "chupe-de-locos",
  2,
  "dales un hervor largo en agua apenas salada hasta que cedan al pincharlos",
  "hiérvelos 45 minutos en agua apenas salada, hasta que cedan al pincharlos",
);
minutos("chupe-de-locos", 2, 45);
campos("chupe-de-locos", { prepMinutes: 22, cookMinutes: 75 });

// ═══════════════════════════════════════════════════════ 2 · ALTOS

// pescado-frito — el rebozado declaraba 90 g de harina contra 200 ml de
// cerveza: más del doble de líquido que de harina no forma costra, se escurre.
// Las dos cosas tienen que declararse en la MISMA base, que es lo que se come.
componente("pescado-frito", "cerveza", {
  quantity: 90,
  notes:
    "es la que se queda en la costra. En el bol se baten 200 ml de cerveza helada con 200 g de harina y sobra: el gas es lo que infla el rebozado",
});
paso(
  "pescado-frito",
  2,
  "bate la harina con la cerveza helada",
  "bate 200 g de harina con 200 ml de cerveza helada",
);

// chips-de-vegetales-al-horno — 1.100 g de láminas no caben en capa única en
// una lata doméstica, y el propio batchPrepNotes ya sabía que al doble no
// funciona mientras la receta base ya iba al triple.
paso(
  "chips-de-vegetales-al-horno",
  5,
  "Extiéndelas en la lata sin que se monten una sobre otra y hornéalas dándolas vuelta a mitad de camino.",
  "Hornea de a una lata en capa única, sin que se monten una sobre otra, dándoles vuelta a mitad de camino y sacando las láminas a medida que se doran en los bordes. Con esta cantidad son tres latas: montadas se cuecen al vapor unas con otras en vez de secarse.",
);
minutos("chips-de-vegetales-al-horno", 5, 105);
campos("chips-de-vegetales-al-horno", { cookMinutes: 107 });

// Pasos de armado declarados en 0 minutos: el total del plato quedaba falseado
// justo en el paso más largo.
minutos("empanadas-de-mariscos", 6, 20);
minutos("empanadas-de-mariscos", 8, 3);
campos("empanadas-de-mariscos", { prepMinutes: 80 });
minutos("pescado-con-costra-de-quinoa", 6, 8);
minutos("pescado-con-costra-de-quinoa", 8, 2);
campos("pescado-con-costra-de-quinoa", { prepMinutes: 28 });
minutos("albondigas-en-salsa-de-mostaza", 9, 3);
campos("albondigas-en-salsa-de-mostaza", { cookMinutes: 44 });

// ═══════════════════════════════════════════════════════ 3 · MEDIOS

// salpicon-de-verduras — cubos de 8 mm cocidos 12 minutos se deshacen, y el
// paso final ya venía peleando con eso ("revuelve con cuidado para no romper").
minutos("salpicon-de-verduras", 2, 7);
paso(
  "salpicon-de-verduras",
  2,
  "hasta que estén firmes; sácalas antes de que se deshagan",
  "unos seis o siete minutos desde que el agua vuelve a hervir: el cubo chico se cuece rápido y pasado se deshace",
);

// ensalada-cobb-casera — una pechuga entera de 240 g no se cuece en 4 minutos
// por lado, y el pollo no se come rosado.
paso(
  "ensalada-cobb-casera",
  2,
  "Sala la pechuga y dórala a la plancha",
  "Abre las pechugas en mariposa o golpéalas hasta dejarlas de un dedo de grosor —enteras el centro queda crudo—, sálalas y dóralas a la plancha",
);

// arroz-al-cilantro — la sustitución con licuadora se contradecía sola: mandaba
// usar "el agua de cocción" antes de que existiera, y dejaba sin ingrediente al
// paso final, que incorpora el cilantro picado fuera del fuego.
paso(
  "arroz-al-cilantro",
  2,
  "licúalo con una taza del agua de cocción y usa esa agua verde para cocer el arroz",
  "licúalo con un chorrito de agua fría hasta hacer un puré verde y resérvalo para incorporarlo fuera del fuego, igual que el picado",
);

// pierna-de-cordero-al-horno-con-papas — estaba publicada en VACUNO. Cualquier
// filtro por categoría devolvía un plato de cordero, y quien buscara cordero no
// lo encontraba. No hay categoría de cordero en el enum: va a TRADICIONAL, que
// es donde el lote pone lo que no calza con las categorías de proteína.
campos("pierna-de-cordero-al-horno-con-papas", { category: "TRADICIONAL" });

// pie-de-limon — 180 g de limón dan unos 65 ml de jugo, no los 120 que la nota
// promete. Y el ácido es justamente lo que cuaja la crema.
componente("pie-de-limon", "limon", {
  quantity: 320,
  minQuantity: 280,
  maxQuantity: 380,
  notes:
    "peso de la fruta entera: de 320 g salen unos 120 ml de jugo colado, que es lo que cuaja la crema. Un limón sutil de 55 g rinde apenas 20-25 ml",
});

// pie-de-carne-y-papas — la posta negra en cubos no se deshace en 55 minutos.
// El mismo corte en otras recetas del lote pide 75 y hasta 180.
minutos("pie-de-carne-y-papas", 3, 90);
campos("pie-de-carne-y-papas", { cookMinutes: 160 });

// filete-de-cerdo-al-merquen — la receta daba el tiempo que produce el defecto
// contra el que ella misma advierte ("pasado de horno queda seco"): 35 minutos
// a 200 °C sobre un filete que está listo a los 22.
paso(
  "filete-de-cerdo-al-merquen",
  5,
  "hornéalo a 200 °C hasta que el centro pierda el rosado fuerte y quede apenas jugoso",
  "hornéalo a 200 °C unos 22 minutos, hasta que el centro marque 63 °C o el jugo salga claro con un dejo rosado",
);
minutos("filete-de-cerdo-al-merquen", 5, 22);
campos("filete-de-cerdo-al-merquen", { cookMinutes: 27 });

// torta-de-yogur-con-base-de-galletas — decía cero cocción y el paso 4 prende
// la cocina para el baño maría. Quien elige la receta por eso, se desorienta.
campos("torta-de-yogur-con-base-de-galletas", { cookMinutes: 5 });

// tarta-de-manzana — 900 g de pulpa no caben en un molde de tarta; el paso 4 ya
// estaba compensando el exceso ("aprieta más de lo que te parece necesario").
componente("tarta-de-manzana", "manzana", {
  quantity: 700,
  minQuantity: 600,
  maxQuantity: 850,
});
paso(
  "tarta-de-manzana",
  3,
  "Estira la masa y forra el molde dejando un borde alto.",
  "Estira la masa y forra un molde de 26 cm dejando un borde alto.",
);

// torta-de-merengue-con-lucuma — la nota dice "el doble del peso de la clara" y
// declaraba 1,67 veces. La nota es la regla que el lector usa para ajustar.
componente("torta-de-merengue-con-lucuma", "azucar granulada", {
  quantity: 480,
  minQuantity: 420,
  maxQuantity: 520,
});

// brownie-con-mousse-de-chocolate — la mousse lleva claras y yemas que nunca
// pasan por calor y la receta no lo decía en ninguna parte. Otras recetas del
// mismo lote sí resuelven el punto (turron-de-vino cuece la clara a 118 °C).
paso(
  "brownie-con-mousse-de-chocolate",
  7,
  "Mezcla las dos yemas con el chocolate tibio",
  "Esta mousse lleva huevo crudo: usa huevos frescos y bien lavados, y no la sirvas a embarazadas, niños chicos ni personas con las defensas bajas. Mezcla las dos yemas con el chocolate tibio",
);

// ═══════════════════════════════════════════════════════ 4 · BAJOS

// ceviche-de-cochayuyo — 20 minutos de remojo dejan el cochayuyo rígido en el
// nudo y salado: no se deja cortar en trocitos parejos como pide el paso 3.
minutos("ceviche-de-cochayuyo", 1, 45);
campos("ceviche-de-cochayuyo", { prepMinutes: 55 });

// pescado-gratinado-con-costra-de-pan-rallado — la reineta es un filete delgado
// y a los 22 minutos está seca y hebrosa.
minutos("pescado-gratinado-con-costra-de-pan-rallado", 4, 15);
campos("pescado-gratinado-con-costra-de-pan-rallado", { cookMinutes: 28 });

// palta-reina — la nota describía cuatro mitades y el número declaraba 480 g,
// que son tres paltas grandes. Quien compre siguiendo la nota se queda corto.
componente("palta-reina", "palta", {
  notes:
    "peso de pulpa, unas tres paltas grandes: seis mitades para servir de a una y media por persona",
});

// ═══════════════════════════════════════════ 5 · IDENTIDADES QUE SE PARTIERON
//
// Los platos los escribieron varios agentes en paralelo y dos de ellos
// bautizaron el mismo producto con nombres distintos. Eso no es un detalle de
// estilo: cada nombre es una FICHA NUTRICIONAL propia, una línea propia en la
// lista de compra y un alimento distinto para el motor clínico. La misma
// persona podría quedar evaluada dos veces contra el mismo hongo.

/** Reapunta todos los componentes de `viejo` a `nuevo` y borra la ficha sobrante. */
function unificarAlimento(viejo, nuevo, { alias = true } = {}) {
  const usos = recetas.flatMap((r) => r.components.filter((c) => c.ingredient === viejo));
  if (usos.length === 0) return fallas.push(`unificar: nadie usa «${viejo}»`);
  if (!recetas.some((r) => r.components.some((c) => c.ingredient === nuevo)))
    return fallas.push(`unificar: «${nuevo}» no existe como destino`);
  for (const c of usos) c.ingredient = nuevo;

  const fichaVieja = datos.alimentos.find((a) => a.canonicalName === viejo);
  const fichaNueva = datos.alimentos.find((a) => a.canonicalName === nuevo);
  if (fichaVieja && fichaNueva && alias) {
    // El nombre que se retira pasa a ALIAS del que queda: quien lo escriba así
    // en el buscador tiene que seguir encontrándolo.
    const juntos = new Set([...(fichaNueva.aliases ?? []), ...(fichaVieja.aliases ?? []), viejo]);
    juntos.delete(nuevo);
    fichaNueva.aliases = [...juntos];
  }
  if (fichaVieja) datos.alimentos = datos.alimentos.filter((a) => a.canonicalName !== viejo);
  hechos.push(`identidad: «${viejo}» → «${nuevo}» (${usos.length} componentes, ficha fusionada)`);
}

// El mismo hongo con dos nombres. Queda el singular sin acento, como el resto
// del vocabulario del catálogo ("cebolla", "tomate", "papa").
unificarAlimento("champinones", "champinon");

// Molida o en grano es una decisión del momento de cocinar, no dos compras
// distintas ni dos fichas: por gramo son el mismo condimento. Las recetas que
// piden grano machacado ya lo dicen en el paso.
unificarAlimento("pimienta negra molida", "pimienta negra");

// `jugo de naranja` era una ficha nueva para algo que el catálogo ya tiene: el
// propio paso dice "recién exprimido", o sea que el lector está exprimiendo
// naranjas, no abriendo un envase. panqueques-con-salsa-de-naranja, del mismo
// lote, ya lo resuelve declarando «naranja» y anotando cuánto jugo rinde.
componente("pollo-entero-asado-al-jugo-de-naranja", "jugo de naranja", {
  ingredient: "naranja",
  quantity: 400,
  unit: "G",
  basis: "EDIBLE_PORTION",
  minQuantity: 320,
  maxQuantity: 480,
  notes:
    "peso de pulpa: de unos 400 g salen los 250 ml de jugo del adobo. Lo que queda en la cáscara y el bagazo no entra al plato",
});
datos.alimentos = datos.alimentos.filter((a) => a.canonicalName !== "jugo de naranja");
hechos.push("identidad: «jugo de naranja» retirado; el adobo usa «naranja» en porción comestible");

// `camarones` y `camarones pelados` SÍ se quedan separados, revisado a
// propósito: no es el mismo peso comprado. Uno declara factor 0,55 desde el
// camarón con caparazón y cabeza, el otro 1 desde la colita pelada. Fusionarlos
// haría que la lista de compra pidiera casi la mitad de lo necesario.

// ═══════════════════════════════════════════════ 6 · TIEMPOS Y TANDAS

/** Quita el grupo de paralelismo de un paso. */
function sinParalelo(slug, indice) {
  const r = receta(slug);
  if (!r) return;
  const p = r.steps[indice - 1];
  if (!p) return fallas.push(`${slug}: no tiene paso ${indice}`);
  if (p.parallelGroup === undefined) return fallas.push(`${slug}/paso ${indice}: no tenía grupo`);
  delete p.parallelGroup;
  hechos.push(`${slug}/paso ${indice}: fuera del grupo paralelo`);
}

/** Pone un paso en un grupo de paralelismo. */
function enParalelo(slug, indice, grupo) {
  const r = receta(slug);
  if (!r) return;
  const p = r.steps[indice - 1];
  if (!p) return fallas.push(`${slug}: no tiene paso ${indice}`);
  p.parallelGroup = grupo;
  hechos.push(`${slug}/paso ${indice}: grupo paralelo ${grupo}`);
}

/** Borra un paso y devuelve su instrucción. */
function borrarPaso(slug, indice) {
  const r = receta(slug);
  if (!r) return;
  const [p] = r.steps.splice(indice - 1, 1);
  if (!p) return fallas.push(`${slug}: no tiene paso ${indice}`);
  hechos.push(`${slug}: borrado el paso ${indice}`);
  return p.instruction;
}

// mote-con-machas-y-salsa-verde — el paso de olla a presión llevaba grupo
// paralelo Y sustitución de equipo a la vez, que es una contradicción: si el
// lector no tiene la olla, el grupo 2 se queda con un solo miembro y el
// paralelismo desaparece; si la tiene, cocina el mote dos veces, porque el paso
// base de 45 minutos sigue en el grupo 1. Una sustitución de equipo reemplaza a
// un paso, no corre junto a otro.
sinParalelo("mote-con-machas-y-salsa-verde", 4);
enParalelo("mote-con-machas-y-salsa-verde", 7, 1);
minutos("mote-con-machas-y-salsa-verde", 3, 40);
paso("mote-con-machas-y-salsa-verde", 4, "cocer el mote 45 minutos", "cocer el mote 40 minutos");
campos("mote-con-machas-y-salsa-verde", { cookMinutes: 45 });

// Horneados que no caben en una lata y declaraban una sola tanda. En el mismo
// lote, galletas-de-anis y galletas-de-canela-y-chocolate SÍ dicen "en dos
// tandas": la biblioteca se contradecía consigo misma.
paso(
  "pajaritos",
  4,
  "Hornea sobre lata con papel",
  "Hornea en tres tandas sobre lata con papel —con 400 g de harina no caben en una sola—",
);
minutos("pajaritos", 4, 36);
campos("pajaritos", { cookMinutes: 36 });

paso(
  "palmeritas",
  3,
  "Ponlas bien separadas en la lata con papel",
  "Ponlas bien separadas en la lata con papel, en dos latas —se hinchan al doble y pegadas se sueltan—",
);
minutos("palmeritas", 3, 36);
campos("palmeritas", { cookMinutes: 36 });

paso(
  "pizza-casera-de-queso-y-tomate",
  4,
  "Pasa la pizza con el papel sobre la lata caliente",
  "Hornea una pizza a la vez: pasa la primera con el papel sobre la lata caliente",
);
minutos("pizza-casera-de-queso-y-tomate", 4, 20);
campos("pizza-casera-de-queso-y-tomate", { cookMinutes: 52 });

// Minutos declarados que no cuadraban con la suma de los pasos. La etiqueta
// RAPIDA se recalcula: si el plato real pasa de 45 minutos, la etiqueta miente.
campos("spaghetti-mediterraneo", { cookMinutes: 25 });
campos("machas-en-salsa-verde", { cookMinutes: 27 });
campos("zapallitos-italianos-rellenos-con-carne", { cookMinutes: 66 });
campos("papas-gringas-rellenas-con-choclo-y-queso", { cookMinutes: 77 });
campos("papas-mayo", { cookMinutes: 25 });
campos("arroz-con-crema-de-choclo", { cookMinutes: 34, prepMinutes: 16 });
quitarEtiqueta("arroz-con-crema-de-choclo", "RAPIDA");

// empanadas-fritas-de-pino — declaraba 50 minutos anidando una masa de 63 y un
// pino aparte: quien parte de cero se encuentra con dos horas largas. Y sus
// propios pasos de fuego suman 27, no 18.
campos("empanadas-fritas-de-pino", { cookMinutes: 27 });
for (const s of [
  "empanadas-fritas-de-pino",
  "empanadas-de-queso-fritas",
  "empanadas-de-pastelera-de-choclo",
]) {
  const r = receta(s);
  if (r && !r.description.includes("preparaciones previas")) {
    r.description +=
      " Los tiempos son con la masa ya hecha: son preparaciones previas y, partiendo de cero, hay que sumarles la masa.";
    hechos.push(`${s}: la descripción avisa que la masa es preparación previa`);
  }
}

// masa-de-empanadas-al-horno — es un COMPONENTE, y su último paso la convertía
// a medias en un plato terminado: "rellena, dobla, sella, pinta y hornea" en
// tres minutos, sin declarar relleno alguno. La receta termina donde termina el
// componente; el armado va a las notas, como referencia.
{
  const cola = borrarPaso("masa-de-empanadas-al-horno", 7);
  const r = receta("masa-de-empanadas-al-horno");
  if (r && cola) {
    r.batchPrepNotes +=
      " Una vez rellenas se sellan con el dedo mojado, se hace el doblez de las esquinas, se pincelan con huevo batido y se hornean a 200 °C unos 25 minutos, hasta que estén doradas.";
    hechos.push("masa-de-empanadas-al-horno: el armado pasó a las notas de lote");
  }
}

// ═══════════════════════════════════════ 7 · ALIÑOS DECLARADOS COMO FRASCO
//
// El motor suma el 100 % de lo declarado. Un chimichurri de 300 g para cuatro
// personas carga 75 g de aliño y 30 ml de aceite por cabeza —unas 270 kcal que
// nadie se comió—, porque lo declarado era el frasco y no la porción. Es la
// misma lógica del aceite retenido, aplicada a un aliño.

/** Escala todas las cantidades de una receta por un factor. */
function escalar(slug, factor, minimo = 1) {
  const r = receta(slug);
  if (!r) return;
  const red = (v) => Math.max(minimo, Math.round(v * factor));
  for (const c of r.components) {
    c.quantity = red(c.quantity);
    if (c.minQuantity !== undefined) c.minQuantity = Math.max(0, Math.round(c.minQuantity * factor));
    if (c.maxQuantity !== undefined) c.maxQuantity = red(c.maxQuantity);
  }
  hechos.push(`${slug}: cantidades escaladas ×${factor} (porción que se come, no el frasco)`);
}

escalar("chimichurri-chileno-de-cebollin-y-cilantro", 0.42);
campos("chimichurri-chileno-de-cebollin-y-cilantro", { prepMinutes: 12 });
{
  const r = receta("chimichurri-chileno-de-cebollin-y-cilantro");
  if (r) r.batchPrepNotes = "Esto es lo que se come entre cuatro, unos 20-25 g por persona sobre el asado. La tanda de frasco es el triple de esto y se guarda cubierta por su propio aceite; sácala del frío un rato antes de servir, que el aceite se solidifica y no se reparte.";
}

escalar("salsa-verde-chilena", 0.4);
campos("salsa-verde-chilena", { prepMinutes: 15 });
{
  const r = receta("salsa-verde-chilena");
  if (r) r.batchPrepNotes = "Esto es la porción de cuatro. Para tener frasco en el refrigerador conviene hacer el triple de una vez: el picado fino es todo el trabajo y cuesta lo mismo.";
}

// chilenitos — la cubierta de yema deja una capa amarilla, y el chilenito de
// vitrina se reconoce por la cubierta blanca de merengue seco. Se mantiene la
// versión de yema porque cambiarla obliga a inventar una identidad de clara que
// el catálogo no tiene, pero AHORA LO DICE: quien esperaba el blanco lo sabe
// antes de hornear. Queda anotado como decisión de producto para Francisco.
{
  const r = receta("chilenitos");
  if (r && !r.description.includes("cubierta va de yema")) {
    r.description +=
      " En esta casa la cubierta va de yema con azúcar flor, secada al horno: queda dorada y no blanca como la del merengue de vitrina.";
    hechos.push("chilenitos: la descripción declara que la cubierta es de yema");
  }
}

// ═══════════════════════════════════════ 8 · ORTOGRAFÍA QUE EL CORPUS NO ALCANZÓ
//
// `tildes-desde-corpus.mjs` repara con el diccionario que sacan las recetas
// bien escritas. Estas palabras no aparecen acentuadas en NINGUNA parte del
// corpus, así que no tienen de dónde repararse. Van revisadas una por una.
const ORTOGRAFIA = [
  ["otono", "otoño"],
  ["banar", "bañar"],
  ["juntala", "júntala"],
  ["dandole", "dándole"],
  ["proposito", "propósito"],
  ["tipico", "típico"],
  ["liquido", "líquido"],
  ["tambien", "también"],
];
let ortografia = 0;
for (const r of recetas) {
  const arregla = (t) => {
    if (typeof t !== "string") return t;
    for (const [mal, bien] of ORTOGRAFIA) {
      t = t.replace(new RegExp(`\\b${mal}\\b`, "g"), (m) => {
        ortografia++;
        return m[0] === m[0].toUpperCase() ? bien[0].toUpperCase() + bien.slice(1) : bien;
      });
    }
    return t;
  };
  for (const k of ["name", "description", "batchPrepNotes"]) if (r[k]) r[k] = arregla(r[k]);
  for (const p of r.steps ?? []) {
    p.instruction = arregla(p.instruction);
    if (p.manualAlternative) p.manualAlternative = arregla(p.manualAlternative);
  }
  for (const c of r.components ?? []) if (c.notes) c.notes = arregla(c.notes);
  for (const a of r.alternatives ?? []) if (a.notes) a.notes = arregla(a.notes);
}
hechos.push(`ortografía: ${ortografia} palabras de la lista revisada`);

// ═══════════════════════════════════════════════════════════════ cierre
if (fallas.length) {
  console.error("\nCORRECCIONES QUE NO SE PUDIERON APLICAR:\n");
  for (const f of fallas) console.error("  ✗ " + f);
  console.error(
    "\nNo se escribió nada. Una corrección que falla en silencio deja el registro\n" +
      "diciendo que el problema está resuelto mientras el plato sigue malo.\n",
  );
  process.exit(1);
}

writeFileSync(archivo, JSON.stringify(datos, null, 2));
console.log(`${hechos.length} correcciones aplicadas sobre ${recetas.length} recetas:\n`);
for (const h of hechos) console.log("  · " + h);
