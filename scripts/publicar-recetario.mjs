#!/usr/bin/env node
/**
 * Publica el recetario chileno en la base de producción.
 *
 *   node scripts/publicar-recetario.mjs            (revisa; no escribe nada)
 *   node scripts/publicar-recetario.mjs --aplicar
 *
 * Francisco aprobó que las 452 recetas entren a producción sabiendo lo que eso
 * significa, y conviene que quede escrito acá y no solo en una conversación:
 *
 *   LA NUTRICIÓN DE ESTE CONTENIDO ES `DEV_SEED`. Son valores de referencia
 *   razonables para que los motores tengan con qué calcular. NO son datos de la
 *   Tabla de Composición Química de los Alimentos Chilenos del INTA. La base
 *   tiene un candado (`nutrition_unverifiable_sources`) que impide marcarlos
 *   como verificados, así que el sistema nunca va a decir que lo están — pero
 *   los números que la familia ve en pantalla salen de ahí.
 *
 * POR QUÉ NO BASTA CON CORRER EL SEED:
 *
 * Los tres archivos usan `insert ... on conflict do nothing`, que es lo
 * correcto para poder re-aplicarlos sin duplicar. Pero tiene una consecuencia
 * que muerde justo acá: un alimento que YA EXISTE en producción no se toca, ni
 * siquiera para agregarle una columna nueva. El `pan marraqueta` y el `limon`
 * de producción son de las primeras semanas del proyecto y no tienen
 * `edible_portion_factor`; el seed nuevo lo trae en la lista de columnas del
 * INSERT, y ese INSERT no se va a ejecutar nunca porque la fila ya está.
 *
 * O sea: sin este script, las 452 recetas entrarían y las 32 que dependen de
 * esos dos factores seguirían sin poder convertirse a cantidad de compra, con
 * el agujero escondido detrás de un "aplicado con éxito".
 *
 * Por eso acá van, después del seed, los UPDATE explícitos de lo que el
 * `on conflict do nothing` se salta. Cada uno dice qué arregla.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");

/** Lee una variable de un archivo de entorno sin volcarlo a memoria global. */
function delArchivo(archivo, clave) {
  if (!existsSync(archivo)) return null;
  for (const linea of readFileSync(archivo, "utf8").split("\n")) {
    const l = linea.trim();
    if (l.startsWith("#") || !l.includes("=")) continue;
    const i = l.indexOf("=");
    if (l.slice(0, i).trim() === clave) return l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

const TOKEN =
  process.env.SUPABASE_ACCESS_TOKEN ??
  delArchivo(path.join(RAIZ, ".env.deploy"), "SUPABASE_ACCESS_TOKEN");
const URL_SUPABASE =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  delArchivo(path.join(RAIZ, "web", ".env.local"), "NEXT_PUBLIC_SUPABASE_URL") ??
  "";
const REF = URL_SUPABASE.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? null;

if (!TOKEN || !REF) {
  console.error("\nFalta el token (.env.deploy) o la URL del proyecto (web/.env.local).\n");
  process.exitCode = 1;
}

async function sql(consulta) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: consulta }),
  });
  const cuerpo = await r.json();
  if (!r.ok || cuerpo?.message) {
    throw new Error(typeof cuerpo?.message === "string" ? cuerpo.message : JSON.stringify(cuerpo));
  }
  return cuerpo;
}

/**
 * Lo que el `on conflict do nothing` no puede arreglar solo.
 *
 * Cada entrada es una corrección sobre una fila que YA EXISTE en producción
 * desde antes de que el dato se conociera. Todas son idempotentes y todas
 * comprueban lo que van a pisar: `where edible_portion_factor is null` para no
 * sobrescribir un valor que alguien haya curado a mano después.
 */
const CORRECCIONES = [
  {
    que: "porción comestible del pan marraqueta",
    porQue:
      "el pan se come entero (factor 1) y su ficha vive en EDIBLE_PORTION; sin el factor, el " +
      "ShoppingEngine no puede llegar a la cantidad de compra y 22 recetas quedan sin resolver",
    sql: `update public.ingredients set edible_portion_factor = 1
          where canonical_name = 'pan marraqueta' and household_id is null
            and edible_portion_factor is null`,
  },
  {
    que: "porción comestible del limón",
    porQue:
      "del limón se usa el jugo y la cáscara se bota: 0,45, el mismo factor que ya declara " +
      "`limon de pica`. Sin él la lista de compra no sabe cuántos limones pedir",
    sql: `update public.ingredients set edible_portion_factor = 0.45
          where canonical_name = 'limon' and household_id is null
            and edible_portion_factor is null`,
  },
];

const SEEDS = [
  // El orden importa y no es alfabético: la biblioteca referencia POR NOMBRE
  // las ensaladas que publica dev_recipes_seed. Al revés muere con
  // "Alimento desconocido en la biblioteca: papa" — es exactamente el error que
  // tuvo el CI en silencio durante meses.
  "supabase/seed/dev_catalog_seed.sql",
  "supabase/seed/dev_recipes_seed.sql",
  "supabase/seed/dev_recipes_biblioteca.sql",
];

async function retrato() {
  const r = await sql(`select
      (select count(*) from public.ingredients where household_id is null) as alimentos,
      (select count(*) from public.meal_template_versions v
         join public.meal_templates t on t.id = v.template_id
        where t.household_id is null and v.status = 'PUBLISHED') as recetas,
      (select count(*) from public.ingredients
        where household_id is null and canonical_name in ('pan marraqueta','limon')
          and edible_portion_factor is null) as sin_factor`);
  return Array.isArray(r) ? r[0] : r;
}

const antes = await retrato();
console.log(
  `\nProducción ahora: ${antes.alimentos} alimentos · ${antes.recetas} recetas publicadas` +
    `\n${antes.sin_factor} de los dos alimentos clave siguen sin porción comestible.`,
);

if (!APLICAR) {
  console.log(
    "\nEsto fue solo la revisión: no se escribió nada.\n\n" +
      "   node scripts/publicar-recetario.mjs --aplicar\n\n" +
      "Recuerda: la nutrición de este contenido es DEV_SEED, no datos del INTA.\n",
  );
  process.exit(0);
}

for (const archivo of SEEDS) {
  const ruta = path.join(RAIZ, archivo);
  const texto = readFileSync(ruta, "utf8");
  // El guardián de codificación del Sprint 11 sigue vigente: un acento roto en
  // una base clínica ya costó una migración de reparación.
  if (texto.includes("�")) {
    console.error(`\n${archivo} trae caracteres de reemplazo: no se manda.\n`);
    process.exitCode = 1;
    break;
  }
  process.stdout.write(`\naplicando ${archivo}… `);
  await sql(texto);
  console.log("ok");
}

for (const c of CORRECCIONES) {
  process.stdout.write(`corrigiendo ${c.que}… `);
  await sql(c.sql);
  console.log("ok");
}

const despues = await retrato();
console.log(
  `\nProducción ahora: ${despues.alimentos} alimentos · ${despues.recetas} recetas publicadas.`,
);
if (despues.sin_factor > 0) {
  // ERROR != VACÍO: si las correcciones no pegaron, se dice. Un "listo" sobre
  // un hueco que sigue abierto es peor que el hueco.
  console.error(
    `\nOJO: ${despues.sin_factor} alimento(s) siguen sin porción comestible. Las recetas que ` +
      `dependen de ellos van a seguir sin poder convertirse a cantidad de compra.\n`,
  );
  process.exitCode = 1;
} else {
  console.log("\nListo. Los dos factores quedaron declarados.\n");
}
