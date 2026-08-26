#!/usr/bin/env node
/**
 * Restituye las tildes de las recetas que se escribieron sin ellas.
 *
 *   node scripts/tildes-desde-corpus.mjs .plan/contenido/salida-AD.json
 *
 * De los 182 platos escritos en paralelo, 29 salieron con el texto entero sin
 * diacríticos: "azucar flor", "Estirala fina", "coccion". No es un detalle de
 * estilo — el texto de esta app lo lee una familia chilena y la regla del
 * proyecto es español chileno bien escrito.
 *
 * POR QUÉ NO UNA LISTA DE PALABRAS ESCRITA A MANO: una lista inventada se
 * equivoca justo en las ambiguas ("si" contra "sí", "el" contra "él") y calla.
 * Acá el diccionario es EL PROPIO CORPUS: las recetas que sí llevan tildes.
 *
 *   - Si en el corpus bueno la palabra aparece SIEMPRE con tilde ("después",
 *     "azúcar", "limón"), se restituye.
 *   - Si aparece de las dos formas ("si"/"sí", "mas"/"más", "solo"/"sólo"), es
 *     ambigua: NO se toca y se informa. Adivinar acá sería cambiar el sentido
 *     de la frase, que es peor que dejarla sin tilde.
 *   - Si no aparece en el corpus, no hay dato: no se toca.
 *
 * Se respeta la mayúscula inicial ("Estirala" → "Estírala").
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const entrada = process.argv[2];
if (!entrada) {
  console.error("uso: node scripts/tildes-desde-corpus.mjs <archivo.json>");
  process.exit(1);
}

const datos = JSON.parse(readFileSync(entrada, "utf8"));
const recetas = Array.isArray(datos) ? datos : datos.recetas;

const sinTilde = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const TILDADA = /[áéíóúüñÁÉÍÓÚÜÑ]/;
/** La de contar necesita `g`: sin la bandera, `match` devuelve solo la primera. */
const TILDADA_G = /[áéíóúüñÁÉÍÓÚÜÑ]/g;

/** Todo el texto en prosa de una receta, que es lo único que lee una persona. */
function prosa(r) {
  return [
    r.name ?? "",
    r.description ?? "",
    ...(r.steps ?? []).flatMap((p) => [p.instruction ?? "", p.manualAlternative ?? ""]),
    r.batchPrepNotes ?? "",
    ...(r.components ?? []).map((c) => c.notes ?? ""),
    ...(r.alternatives ?? []).map((a) => a.notes ?? ""),
  ].join(" ");
}

// ---------------------------------------------------------------- el corpus
// El umbral NO puede ser "tiene al menos una tilde": una receta escrita sin
// diacríticos igual trae un "café" suelto, entra al corpus bueno como si
// escribiera bien y mete su propia falta al diccionario. Ahí "cocción" y
// "coccion" conviven, la palabra se declara ambigua y no se repara nunca.
// El corte va por DENSIDAD contra la mediana del propio lote: quien escribe
// español chileno completo acentúa a un ritmo parejo, y quien no, cae lejos.
const densidad = (r) => {
  const t = prosa(r);
  return t.length === 0 ? 0 : (1000 * (t.match(TILDADA_G) ?? []).length) / t.length;
};
const orden = recetas.map(densidad).sort((a, b) => a - b);
const MEDIANA = orden[Math.floor(orden.length / 2)];
// El umbral de ENSEÑANZA es la mediana entera, no la mitad. Con la mitad
// entraban al diccionario recetas medio reparadas por una corrida anterior, que
// todavía arrastran sus palabras sin tilde: esas erratas bajaban la cuota de
// "azúcar" o "cocción" por debajo del 90 % y la palabra se vetaba a sí misma
// para siempre. Enseña solo quien escribe el español completo.
const UMBRAL = MEDIANA;
const buenas = recetas.filter((r) => densidad(r) >= UMBRAL);
const malas = recetas.filter((r) => densidad(r) < UMBRAL);

/**
 * La biblioteca YA PUBLICADA también enseña.
 *
 * Son cien recetas que pasaron por los guardianes y por revisión, con el
 * español chileno completo. Sin ellas el diccionario solo conoce lo que el
 * propio lote escribió bien, y palabras que este lote SIEMPRE escribió mal
 * ("cómodo", "bañar", "otoño", "júntala") no tienen de dónde repararse: no hay
 * un solo ejemplo bueno adentro del archivo.
 */
const LOTES_PUBLICADOS = ["a", "b", "c", "d", "e"].map((l) =>
  path.join("web", "src", "domain", "recipes", "library", `lote-${l}.ts`),
);
const textoPublicado = LOTES_PUBLICADOS.map((f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
}).join(String.fromCharCode(10));

/** clave sin tilde → conjunto de formas reales vistas en el corpus bueno. */
const formas = new Map();
for (const fuente of [...buenas.map(prosa), textoPublicado]) {
  for (const palabra of fuente.match(/[\p{L}]+/gu) ?? []) {
    const min = palabra.toLowerCase();
    const clave = sinTilde(min);
    if (!formas.has(clave)) formas.set(clave, new Map());
    const m = formas.get(clave);
    m.set(min, (m.get(min) ?? 0) + 1);
  }
}

/**
 * TILDE DIACRÍTICA: pares donde las dos formas son palabras corrientes y la
 * tilde cambia el sentido, no la ortografía. Acá no hay dato que valga —
 * "si vas a usarlo" y "sí, va" conviven en cualquier receta. No se tocan nunca.
 *
 * Es una lista de VETO, no de reparación: lo peor que puede hacer es dejar una
 * palabra como estaba. Una lista de reparación escrita a mano, en cambio,
 * puede cambiarle el sentido a una frase, y eso sí es daño.
 */
const DIACRITICAS = new Set([
  "el", "tu", "mi", "si", "se", "de", "te", "mas", "solo", "aun", "que", "cual",
  "quien", "como", "cuando", "cuanto", "donde", "esta", "este", "esa", "ese",
  "aquel", "porque", "porqu", "o", "e", "frio", "frios", "fria", "frias",
  "continuo", "publico", "practico", "critico", "termino", "limite", "calculo",
]);

const AMBIGUAS = [];
/**
 * clave → forma con tilde cuando el corpus la respalda de forma abrumadora.
 *
 * El criterio NO es unanimidad. Un corpus escrito por varias manos siempre trae
 * dos o tres deslices ("coccion" entre cien "cocción"), y con unanimidad esos
 * tres deslices vetaban la palabra entera y "cocción" no se reparaba nunca.
 * Se pide DOMINANCIA: la forma con tilde manda por 85 % o más y la desnuda
 * aparece a lo sumo dos veces. Las que de verdad se escriben de las dos formas
 * no llegan ni cerca de ese margen, así que caen solas.
 */
const diccionario = new Map();
for (const [clave, vistas] of formas) {
  const variantes = [...vistas.keys()];
  const conTilde = variantes.filter((v) => TILDADA.test(v));
  if (conTilde.length === 0) continue; // nunca lleva tilde: nada que hacer
  if (DIACRITICAS.has(clave)) continue; // el sentido decide, no la frecuencia

  const total = variantes.reduce((n, v) => n + vistas.get(v), 0);
  const desnudas = variantes.filter((v) => !TILDADA.test(v)).reduce((n, v) => n + vistas.get(v), 0);
  conTilde.sort((a, b) => vistas.get(b) - vistas.get(a));
  const gana = conTilde[0];
  const cuota = vistas.get(gana) / total;

  const otraAcentuacion = conTilde.length > 1 && vistas.get(conTilde[1]) > 1;
  // El veto va por PROPORCIÓN y no por un conteo absoluto. Con "a lo sumo dos
  // desnudas" bastaban tres deslices entre cuarenta para vetar "azúcar" — y
  // como esos tres viven dentro de recetas que por lo demás escriben bien, no
  // se reparaban nunca por ningún camino. Si la forma con tilde manda nueve a
  // uno, las desnudas son erratas, no una segunda ortografía.
  if (cuota < 0.9 || otraAcentuacion) {
    AMBIGUAS.push({ clave, variantes: variantes.map((v) => `${v}×${vistas.get(v)}`) });
    continue;
  }
  diccionario.set(clave, gana);
}

/** Aplica el diccionario a un texto conservando la mayúscula inicial. */
function reparar(texto, contador) {
  if (typeof texto !== "string" || texto === "") return texto;
  return texto.replace(/[\p{L}]+/gu, (palabra) => {
    if (TILDADA.test(palabra)) return palabra;
    const arreglada = diccionario.get(sinTilde(palabra.toLowerCase()));
    if (!arreglada || arreglada === palabra.toLowerCase()) return palabra;
    const salida =
      palabra[0] === palabra[0].toUpperCase()
        ? arreglada[0].toUpperCase() + arreglada.slice(1)
        : arreglada;
    contador.push(`${palabra} → ${salida}`);
    return salida;
  });
}

// Se repara TODO el lote, no solo lo que cae bajo el umbral. Una errata suelta
// ("azucar" entre cuarenta "azúcar") vive justamente dentro de una receta que
// por lo demás escribe bien; si solo se tocaran las malas, esa errata sería
// intocable y además seguiría envenenando el diccionario de la próxima corrida.
// El umbral decide qué texto ENSEÑA el diccionario; la reparación va a todos.
let tocadas = 0;
const cambios = [];
for (const r of recetas) {
  const c = [];
  r.name = reparar(r.name, c);
  r.description = reparar(r.description, c);
  if (r.batchPrepNotes) r.batchPrepNotes = reparar(r.batchPrepNotes, c);
  for (const p of r.steps ?? []) {
    p.instruction = reparar(p.instruction, c);
    if (p.manualAlternative) p.manualAlternative = reparar(p.manualAlternative, c);
  }
  for (const comp of r.components ?? []) if (comp.notes) comp.notes = reparar(comp.notes, c);
  for (const a of r.alternatives ?? []) if (a.notes) a.notes = reparar(a.notes, c);
  if (c.length) {
    tocadas++;
    cambios.push({ slug: r.slug, n: c.length, muestra: [...new Set(c)].slice(0, 10) });
  }
}

writeFileSync(entrada, JSON.stringify(datos, null, 2));

console.log(`corpus: mediana ${MEDIANA.toFixed(1)} tildes/1000 car · umbral ${UMBRAL.toFixed(1)}`);
console.log(`${buenas.length} recetas bien acentuadas, ${malas.length} bajo el umbral`);
console.log(`diccionario: ${diccionario.size} palabras unánimes · ${AMBIGUAS.length} ambiguas que NO se tocan`);
console.log(`reparadas: ${tocadas} recetas\n`);
for (const c of cambios) console.log(`  ${c.slug} (${c.n}): ${c.muestra.join(", ")}`);
console.log("\nambiguas más frecuentes (se dejan como estaban, a propósito):");
for (const a of AMBIGUAS.slice(0, 30)) console.log("   " + a.clave + ": " + a.variantes.join(" "));
