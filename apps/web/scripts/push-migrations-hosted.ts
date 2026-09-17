/**
 * Aplica las migraciones del repositorio a un proyecto Supabase ALOJADO
 * usando la Management API sobre HTTPS.
 *
 *   node scripts/push-migrations-hosted.ts --plan     (no escribe nada)
 *   node scripts/push-migrations-hosted.ts
 *
 * ¿Por qué existe, si `supabase db push` hace justo esto?
 *
 * Porque `supabase db push` abre una conexión PostgreSQL directa al puerto 5432
 * (o 6543 del pooler), y hay entornos de desarrollo y de integración continua
 * donde solo sale el tráfico HTTPS. En esos entornos `db push` se queda
 * esperando hasta agotar el tiempo. Este script recorre exactamente los mismos
 * archivos de `supabase/migrations/`, en el mismo orden, y lleva el mismo
 * registro en `supabase_migrations.schema_migrations`, de modo que un
 * `supabase db push` posterior desde otra máquina vea las migraciones como ya
 * aplicadas y no intente repetirlas.
 *
 * No reconstruye ni reescribe SQL: envía el contenido de cada archivo tal cual.
 * Si una migración falla, se detiene ahí y sale con código distinto de cero.
 *
 * Necesita:
 *   SUPABASE_ACCESS_TOKEN   token de acceso personal (empieza por `sbp_`),
 *                           desde https://supabase.com/dashboard/account/tokens
 *   SUPABASE_PROJECT_REF    referencia del proyecto; si falta se deduce de
 *                           NEXT_PUBLIC_SUPABASE_URL
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/* ------------------------------------------------------------------ entorno */

function loadEnvLocal(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      const raw = readFileSync(resolve(root, file), "utf8");
      for (const line of raw.split("\n")) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (!match) continue;
        const value = match[2].replace(/^["']|["']$/g, "").trim();
        if (value && !process.env[match[1]]) process.env[match[1]] = value;
      }
    } catch {
      // Puede no existir: las variables pueden venir del entorno.
    }
  }
}

loadEnvLocal();

const PLAN_ONLY = process.argv.includes("--plan");

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? "";

function projectRef(): string {
  const explicit = process.env.SUPABASE_PROJECT_REF;
  if (explicit) return explicit;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return "";
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return "";
  }
}

const REF = projectRef();

/* -------------------------------------------------------------- migraciones */

interface Migration {
  version: string;
  name: string;
  file: string;
  sql: string;
}

function migrations(): Migration[] {
  const dir = resolve(root, "supabase/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => {
      // `supabase db push` parte el nombre en <version>_<nombre>.sql
      const match = /^(\d+)_(.*)\.sql$/.exec(f);
      if (!match) {
        throw new Error(
          `El nombre "${f}" no sigue el formato <marca de tiempo>_<nombre>.sql ` +
            "que usa el CLI de Supabase. Renómbralo antes de continuar.",
        );
      }
      return {
        version: match[1],
        name: match[2],
        file: basename(f),
        sql: readFileSync(resolve(dir, f), "utf8"),
      };
    });
}

/* ---------------------------------------------------------- Management API */

/**
 * Base de la Management API. Se puede apuntar a otro sitio para probar el
 * propio script contra un PostgreSQL local sin tocar el proyecto alojado.
 */
const API = process.env.SUPABASE_API_URL ?? "https://api.supabase.com";

async function runSql(query: string): Promise<unknown> {
  const response = await fetch(`${API}/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const text = await response.text();

  if (!response.ok) {
    // El cuerpo del error trae el mensaje de PostgreSQL, que es lo útil.
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

/** Comillas simples de PostgreSQL para incrustar un literal. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/* ------------------------------------------------------------------ proceso */

async function main(): Promise<void> {
  const missing: string[] = [];
  if (!TOKEN) missing.push("SUPABASE_ACCESS_TOKEN");
  if (!REF) missing.push("SUPABASE_PROJECT_REF (o NEXT_PUBLIC_SUPABASE_URL)");

  const pending = migrations();

  if (PLAN_ONLY && missing.length > 0) {
    // Sin credenciales todavía se puede mostrar qué se aplicaría.
    console.log(`\nMigraciones del repositorio (${pending.length}):\n`);
    for (const m of pending) console.log(`   ${m.version}  ${m.name}`);
    console.log("\nFaltan variables para consultar el estado remoto:\n");
    for (const name of missing) console.log(`   · ${name}`);
    console.log("");
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error("\n✗ Faltan variables para aplicar las migraciones:\n");
    for (const name of missing) console.error(`   · ${name}`);
    console.error(
      "\nColócalas en apps/web/.env.local. El token personal se crea en\n" +
        "https://supabase.com/dashboard/account/tokens y no se versiona.\n",
    );
    process.exit(1);
  }

  console.log(`\n→ Proyecto ${REF}`);

  // El CLI de Supabase usa este mismo esquema y esta misma tabla.
  await runSql(`
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      statements text[],
      name text
    );
  `);

  const appliedRows = (await runSql(
    "select version from supabase_migrations.schema_migrations order by version;",
  )) as Array<{ version: string }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  console.log(`→ Ya aplicadas en el proyecto: ${applied.size}`);

  const todo = pending.filter((m) => !applied.has(m.version));

  if (todo.length === 0) {
    console.log("✓ El proyecto ya está al día. Nada que aplicar.\n");
    return;
  }

  console.log(`→ Por aplicar: ${todo.length}\n`);

  if (PLAN_ONLY) {
    for (const m of todo) console.log(`   ${m.version}  ${m.name}`);
    console.log("\n(--plan: no se escribió nada)\n");
    return;
  }

  for (const m of todo) {
    process.stdout.write(`   · ${m.file} ... `);
    try {
      await runSql(m.sql);
    } catch (error) {
      console.log("FALLÓ");
      console.error(`\n✗ ${m.file}\n  ${(error as Error).message}\n`);
      console.error(
        "La migración no quedó registrada. Corrige la causa y vuelve a\n" +
          "ejecutar: se retomará desde este mismo archivo.\n",
      );
      process.exit(1);
    }

    await runSql(
      `insert into supabase_migrations.schema_migrations (version, name, statements)
       values (${literal(m.version)}, ${literal(m.name)}, array[${literal(m.sql)}])
       on conflict (version) do nothing;`,
    );
    console.log("ok");
  }

  console.log(`\n✓ ${todo.length} migraciones aplicadas en ${REF}.\n`);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}\n`);
  process.exit(1);
});
