/**
 * Aplica la semilla geográfica oficial a un proyecto Supabase ALOJADO de
 * desarrollo, por HTTPS.
 *
 *   npm run db:seed:hosted -- --plan
 *   npm run db:seed:hosted -- --project-ref <ref>
 *
 * Por qué existe: `supabase db push --include-seed` necesita una conexión
 * PostgreSQL directa al puerto 5432 (o 6543 del pooler). Donde ese puerto está
 * cerrado no hay forma de aplicar la semilla con el CLI, y sin las 346 comunas
 * no se puede publicar un trabajo: `jobs.commune_id` es una clave foránea.
 *
 * Esto NO es una migración y no se registra como tal. Las migraciones describen
 * el esquema; esto son datos de referencia. Mezclarlos haría que
 * `supabase db push` creyera aplicada una migración que no existe.
 *
 * Salvaguardas, en este orden:
 *
 *  1. Solo desarrollo: se niega a correr con NODE_ENV=production.
 *  2. Confirmación explícita: hay que escribir el project ref en la línea de
 *     órdenes y tiene que coincidir con el de NEXT_PUBLIC_SUPABASE_URL.
 *  3. Fuente oficial: lee `supabase/seed/001_geo.sql`, generado desde
 *     `src/lib/geo/chile.ts`. No trae datos propios.
 *  4. Analiza el SQL antes de enviarlo y se niega si toca algo que no sean las
 *     tres tablas de referencia, si menciona `auth.` o `storage.`, o si parece
 *     traer credenciales. Es una comprobación de la máquina, no una promesa.
 *  5. Idempotente: el archivo usa `on conflict do nothing`; se exige que así
 *     sea antes de enviarlo.
 *  6. Solo informa conteos. Nunca imprime filas, claves ni el token.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvLocal } from "./env-local.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/* ------------------------------------------------------------------ entorno */

loadEnvLocal(root);

const PLAN_ONLY = process.argv.includes("--plan");

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? "";

function projectRefFromUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return "";
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return "";
  }
}

const REF = process.env.SUPABASE_PROJECT_REF || projectRefFromUrl();

/* -------------------------------------------------------- 1. solo desarrollo */

if (process.env.NODE_ENV === "production") {
  console.error(
    "\n✗ Esta semilla es solo para desarrollo o staging.\n" +
      "  NODE_ENV=production. No se ejecuta.\n",
  );
  process.exit(1);
}

/* ------------------------------------------------- 4 y 5. análisis del SQL */

const SEED_PATH = "supabase/seed/001_geo.sql";

/** Únicas tablas que esta semilla puede tocar. */
const ALLOWED_TABLES = ["public.countries", "public.regions", "public.communes"];

/**
 * Cuenta las tuplas de un `insert ... values (...), (...)`.
 *
 * Contar paréntesis de apertura no sirve: los valores traen paréntesis dentro
 * (`O''Higgins` no, pero sí los hay en otros nombres) y `on conflict (code)`
 * abre uno más. Se recorre el texto entre `values` y `on conflict` llevando la
 * profundidad, y solo cuenta la que se abre en el nivel cero.
 */
function countTuples(block: string): number {
  const from = block.search(/\bvalues\b/i);
  if (from === -1) return 0;
  const until = block.search(/\bon\s+conflict\b/i);
  const body = block.slice(from, until === -1 ? undefined : until);

  let depth = 0;
  let inString = false;
  let tuples = 0;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      // '' dentro de una cadena es una comilla escapada, no su fin.
      if (ch === "'") {
        if (body[i + 1] === "'") i += 1;
        else inString = false;
      }
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === "(") {
      if (depth === 0) tuples += 1;
      depth += 1;
    } else if (ch === ")") depth -= 1;
  }

  return tuples;
}

interface Analysis {
  sql: string;
  inserts: Map<string, number>;
  problems: string[];
}

function analyse(): Analysis {
  const sql = readFileSync(resolve(root, SEED_PATH), "utf8");
  const problems: string[] = [];
  const inserts = new Map<string, number>();

  // Cada `insert into <tabla> ... values (...)` y cuántas tuplas trae.
  const blocks = sql.split(/\binsert\s+into\s+/i).slice(1);
  for (const block of blocks) {
    const table = (/^([\w."]+)/.exec(block)?.[1] ?? "").replace(/"/g, "").toLowerCase();
    if (!ALLOWED_TABLES.includes(table)) {
      problems.push(`escribe en una tabla no permitida: ${table}`);
      continue;
    }
    if (!/\bon\s+conflict\b/i.test(block)) {
      problems.push(`el bloque de ${table} no trae "on conflict": no sería idempotente`);
    }
    inserts.set(table, (inserts.get(table) ?? 0) + countTuples(block));
  }

  // Nada de identidades ni de almacenamiento desde SQL.
  for (const [pattern, why] of [
    [/\bauth\s*\./i, "menciona el esquema auth: las cuentas no se crean desde SQL"],
    [/\bstorage\s*\./i, "menciona el esquema storage"],
    [/encrypted_password|crypt\s*\(|\bpassword\b/i, "parece traer contraseñas"],
    [/\bsb_secret_|\bsbp_|service_role_key/i, "parece traer credenciales"],
    [/\b(drop|truncate|alter)\s+table\b/i, "altera o borra tablas"],
  ] as Array<[RegExp, string]>) {
    if (pattern.test(sql)) problems.push(why);
  }

  return { sql, inserts, problems };
}

/* ---------------------------------------------------------- Management API */

const API = process.env.SUPABASE_API_URL ?? "https://api.supabase.com";

async function runSql(query: string): Promise<unknown> {
  const response = await fetch(`${API}/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      detail = parsed.message ?? parsed.error ?? text;
    } catch {
      // Se queda con el texto crudo.
    }
    throw new Error(`HTTP ${response.status} · ${detail}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

async function counts(): Promise<Record<string, number>> {
  // Una sola fila con tres columnas, no tres filas: así no depende de cómo la
  // Management API ordene ni etiquete un `union all`.
  const rows = (await runSql(`
    select (select count(*) from public.countries)::int as countries,
           (select count(*) from public.regions)::int   as regions,
           (select count(*) from public.communes)::int  as communes;
  `)) as Array<Record<string, number>>;
  const row = rows[0];
  if (!row) throw new Error("el proyecto no devolvió conteos: ¿está aplicado el esquema?");
  return row;
}

/* ------------------------------------------------------------------ proceso */

async function main(): Promise<void> {
  const { sql, inserts, problems } = analyse();

  console.log(`\nFuente: ${SEED_PATH}`);
  for (const [table, n] of [...inserts].sort()) {
    console.log(`   ${table.padEnd(18)} ${n} filas`);
  }

  if (problems.length > 0) {
    console.error("\n✗ La semilla no pasó el análisis previo:\n");
    for (const p of problems) console.error(`   · ${p}`);
    console.error("");
    process.exit(1);
  }
  console.log("   análisis previo: solo tablas de referencia, idempotente, sin credenciales");

  // -------------------------------------------- 2. confirmación del project ref
  const confirmed = flag("--project-ref");

  if (!PLAN_ONLY) {
    if (!confirmed) {
      console.error(
        "\n✗ Falta la confirmación del proyecto de destino.\n\n" +
          `  Vuelve a ejecutar con:  npm run db:seed:hosted -- --project-ref ${REF || "<ref>"}\n\n` +
          "  Se pide a propósito: escribir el ref es lo que impide sembrar\n" +
          "  el proyecto equivocado por tener otra variable en el entorno.\n",
      );
      process.exit(1);
    }
    if (confirmed !== REF) {
      console.error(
        `\n✗ El ref confirmado (${confirmed}) no es el del entorno (${REF || "sin definir"}).\n` +
          "  No se ejecuta nada.\n",
      );
      process.exit(1);
    }
  }

  const missing: string[] = [];
  if (!TOKEN) missing.push("SUPABASE_ACCESS_TOKEN");
  if (!REF) missing.push("SUPABASE_PROJECT_REF (o NEXT_PUBLIC_SUPABASE_URL)");
  if (missing.length > 0) {
    console.error("\n✗ Faltan variables para hablar con el proyecto:\n");
    for (const name of missing) console.error(`   · ${name}`);
    console.error("\nColócalas en apps/web/.env.local.\n");
    process.exit(1);
  }

  console.log(`\n→ Proyecto ${REF}`);

  const before = await counts();
  console.log(
    `→ Antes:  países ${before.countries}, regiones ${before.regions}, comunas ${before.communes}`,
  );

  if (PLAN_ONLY) {
    console.log("\n(--plan: no se escribió nada)\n");
    return;
  }

  await runSql(sql);

  const after = await counts();
  console.log(
    `→ Después: países ${after.countries}, regiones ${after.regions}, comunas ${after.communes}`,
  );

  const expected = { countries: 1, regions: 16, communes: 346 };
  const wrong = Object.entries(expected).filter(([k, v]) => after[k] !== v);
  if (wrong.length > 0) {
    console.error("\n✗ Los conteos no son los esperados:\n");
    for (const [k, v] of wrong) console.error(`   · ${k}: hay ${after[k]}, se esperaban ${v}`);
    console.error("");
    process.exit(1);
  }

  console.log("\n✓ Semilla geográfica aplicada: 1 país, 16 regiones, 346 comunas.\n");
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}\n`);
  process.exit(1);
});
