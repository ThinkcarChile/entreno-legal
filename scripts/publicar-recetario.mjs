#!/usr/bin/env node
/**
 * Publica el recetario chileno en la base de producción.
 *
 *   node scripts/publicar-recetario.mjs            (revisa; no escribe nada)
 *   node scripts/publicar-recetario.mjs --aplicar
 *   node scripts/publicar-recetario.mjs --ref <proyecto> --aplicar   (otro proyecto: staging)
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

/**
 * `--ref <proyecto>`: publicar el recetario en OTRO proyecto (staging). SIN la
 * opción, el ref sale de NEXT_PUBLIC_SUPABASE_URL como siempre: el
 * comportamiento por defecto no cambia. Lo usa `scripts/staging-bootstrap.mjs`,
 * que necesita las mismas 452 recetas —y los mismos testigos por seed, que son
 * lo que hace idempotente la corrida— en el proyecto de pruebas.
 *
 * Un `--ref` sin valor corta en vez de caer a producción.
 */
function extraerRef(argv) {
  const resto = [];
  let ref = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--ref") {
      ref = argv[i + 1];
      i += 1;
      if (ref === undefined || ref.startsWith("--")) {
        throw new Error("--ref necesita el ref del proyecto a continuación (por ejemplo --ref abcdefghijklmnopqrst).");
      }
    } else if (a.startsWith("--ref=")) {
      ref = a.slice("--ref=".length);
    } else {
      resto.push(a);
    }
  }
  if (ref !== null && !/^[a-z0-9]+$/.test(ref)) {
    throw new Error(
      `--ref recibió "${ref}", que no tiene la forma de un ref de Supabase (solo minúsculas y dígitos).`,
    );
  }
  return { ref, resto };
}

let REF_EXPLICITO = null;
let ARGUMENTOS = [];
try {
  ({ ref: REF_EXPLICITO, resto: ARGUMENTOS } = extraerRef(process.argv.slice(2)));
} catch (e) {
  // Antes de cualquier fetch: acá process.exit no deja sockets a medio cerrar.
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

const APLICAR = ARGUMENTOS.includes("--aplicar");

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
const REF = REF_EXPLICITO ?? URL_SUPABASE.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? null;
// Cómo se llama el proyecto en los mensajes: sin --ref es producción y se dice
// así; con --ref se nombra el ref, porque "Producción ahora: 0 recetas" leído
// sobre staging manda a alguien a revisar la base equivocada.
const NOMBRE_DEL_PROYECTO = REF_EXPLICITO ? `Proyecto ${REF} (--ref)` : "Producción";

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

/**
 * Cada seed con un TESTIGO: una consulta que dice si ya está aplicado.
 *
 * Hace falta porque los tres NO son iguales de idempotentes, y suponerlo costó
 * un intento fallido contra producción:
 *
 *   · `dev_recipes_biblioteca.sql` sí lo es (212 `on conflict do nothing`): se
 *     puede re-aplicar sin duplicar nada.
 *   · `dev_catalog_seed.sql` NO. Sus inserts revientan contra una fila que ya
 *     existe — y reventó, con `duplicate key ... (pechuga de pollo sin piel)`.
 *     Ese seed se aplicó a producción en las primeras semanas del proyecto.
 *
 * O sea que "aplicar los tres en orden" es correcto en una base nueva y
 * equivocado en la de producción. El testigo resuelve las dos: mira si el
 * contenido ya está y salta el que sobra, en vez de confiar en la memoria de
 * alguien sobre qué se corrió hace meses.
 */
const SEEDS = [
  {
    archivo: "supabase/seed/dev_catalog_seed.sql",
    // Sus inserts NO son idempotentes, así que el testigo no es una comodidad:
    // es lo único que evita que reviente.
    testigo: "select 1 from public.ingredients where canonical_name = 'pechuga de pollo sin piel' and household_id is null",
  },
  {
    archivo: "supabase/seed/dev_recipes_seed.sql",
    testigo: "select 1 from public.meal_templates where name = 'Ensalada chilena' and household_id is null",
  },
  {
    // La biblioteca va ÚLTIMA y no es alfabético: referencia POR NOMBRE las
    // ensaladas que publica el seed anterior. Al revés muere con "Alimento
    // desconocido en la biblioteca: papa" — es el mismo error que tuvo el CI en
    // silencio durante meses.
    archivo: "supabase/seed/dev_recipes_biblioteca.sql",
    testigo: "select 1 from public.meal_templates where name = 'Charquicán' and household_id is null",
  },
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
  `\n${NOMBRE_DEL_PROYECTO} ahora: ${antes.alimentos} alimentos · ${antes.recetas} recetas publicadas` +
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

for (const { archivo, testigo } of SEEDS) {
  const ya = await sql(`select exists (${testigo}) as puesto`);
  if ((Array.isArray(ya) ? ya[0] : ya)?.puesto) {
    console.log(`
${archivo} — ya estaba aplicado, se salta`);
    continue;
  }
  const texto = readFileSync(path.join(RAIZ, archivo), "utf8");
  // El guardián de codificación del Sprint 11 sigue vigente: un acento roto en
  // una base clínica ya costó una migración de reparación.
  if (texto.includes("�")) {
    console.error(`
${archivo} trae caracteres de reemplazo: no se manda.
`);
    process.exitCode = 1;
    break;
  }
  process.stdout.write(`
aplicando ${archivo}… `);
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
  `\n${NOMBRE_DEL_PROYECTO} ahora: ${despues.alimentos} alimentos · ${despues.recetas} recetas publicadas.`,
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
