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
 * No reconstruye ni reescribe SQL: envía el contenido de cada archivo tal cual,
 * y en LA MISMA petición su fila del historial. La Management API ejecuta una
 * petición con varias sentencias como una sola transacción implícita, así que
 * la migración y su registro se confirman juntos o no se confirma ninguno (es
 * lo que hace el CLI, que encola el registro en la transacción de la
 * migración). Antes iban en dos peticiones: si la segunda se perdía —red,
 * 5xx, token caducado, o un timeout HTTP con PostgreSQL ya confirmando—, la
 * migración quedaba aplicada sin registrar, y al reintentar se volvía a
 * aplicar. Cuatro migraciones no se pueden aplicar dos veces (crean un tipo,
 * un trigger o una restricción sin `if not exists`), y el despliegue quedaba
 * atascado hasta insertar la fila a mano.
 *
 * Si una migración falla, se detiene ahí y sale con código distinto de cero.
 * Volver a ejecutarlo es seguro: lo registrado se salta, y lo que no quedó
 * registrado tampoco quedó aplicado.
 *
 * Una migración no debe abrir ni cerrar su propia transacción (`begin;` /
 * `commit;`): rompería esa garantía. El script se niega a enviarla.
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

import { loadEnvLocal } from "./env-local.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/* ------------------------------------------------------------------ entorno */

loadEnvLocal(root);

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

/**
 * Las sentencias de primer nivel del archivo, sin comentarios, literales,
 * identificadores entre comillas ni cuerpos entre `$$`: un `;` dentro de
 * cualquiera de ellos no separa sentencias.
 */
function topLevelStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      current += " ";
    } else if (c === "/" && next === "*") {
      // PostgreSQL anida los comentarios de bloque.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      current += " ";
    } else if (c === "'") {
      // E'…' admite \' además de ''.
      const backslash = /(^|[^A-Za-z0-9_$])[eE]$/.test(current);
      i += 1;
      while (i < sql.length) {
        if (backslash && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i += 1;
      }
      i += 1;
      current += "''";
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      i = end < 0 ? sql.length : end + 1;
      current += '""';
    } else if (c === "$" && !/[A-Za-z0-9_$]$/.test(current)) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
        current += " $$ ";
      } else {
        current += c;
        i += 1;
      }
    } else if (c === ";") {
      statements.push(current.trim());
      current = "";
      i += 1;
    } else {
      current += c;
      i += 1;
    }
  }
  statements.push(current.trim());
  return statements.filter(Boolean);
}

/**
 * ¿Abre, cierra o parte el archivo su propia transacción? Mira la primera
 * palabra de cada sentencia de primer nivel: el `begin` y el `end;` de un
 * cuerpo PL/pgSQL, o el `end` de un `case`, no cuentan; `begin isolation level
 * …`, `commit and chain` o un `savepoint`, sí.
 */
function hasTransactionControl(sql: string): boolean {
  return topLevelStatements(sql).some((s) =>
    /^(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b/i.test(
      s,
    ),
  );
}

/**
 * La migración y su fila del historial, en una sola petición: una sola
 * transacción implícita. El `;` en su propia línea cierra la última sentencia
 * del archivo aunque acabe en un comentario o sin punto y coma.
 */
function migrationBatch(m: Migration): string {
  return (
    `${m.sql}\n;\n` +
    `insert into supabase_migrations.schema_migrations (version, name, statements)\n` +
    `values (${literal(m.version)}, ${literal(m.name)}, array[${literal(m.sql)}])\n` +
    `on conflict (version) do nothing;\n`
  );
}

/** ¿Quedó registrada? Para saber qué pasó cuando la respuesta no llegó. */
async function isRecorded(version: string): Promise<boolean> {
  const rows = (await runSql(
    `select 1 from supabase_migrations.schema_migrations where version = ${literal(version)};`,
  )) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
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

  const conTransaccion = todo.filter((m) => hasTransactionControl(m.sql));
  if (conTransaccion.length > 0) {
    console.error("✗ Estas migraciones abren o cierran su propia transacción:\n");
    for (const m of conTransaccion) console.error(`   · ${m.file}`);
    console.error(
      "\nEl script envía cada migración junto con su registro en una sola\n" +
        "transacción; un `begin;` o `commit;` dentro del archivo la partiría.\n" +
        "Quítalos: cada archivo ya se aplica entero o no se aplica.\n",
    );
    process.exit(1);
  }

  if (PLAN_ONLY) {
    for (const m of todo) console.log(`   ${m.version}  ${m.name}`);
    console.log("\n(--plan: no se escribió nada)\n");
    return;
  }

  for (const m of todo) {
    process.stdout.write(`   · ${m.file} ... `);
    try {
      await runSql(migrationBatch(m));
    } catch (error) {
      // Sin respuesta no se sabe si PostgreSQL confirmó. Como la migración y
      // su registro van juntos, basta con mirar el registro.
      let recorded: boolean | null = null;
      try {
        recorded = await isRecorded(m.version);
      } catch {
        // Tampoco se pudo consultar: se informa como desconocido.
      }

      if (recorded) {
        console.log("ok (la respuesta se perdió, pero quedó aplicada y registrada)");
        continue;
      }

      console.log("FALLÓ");
      console.error(`\n✗ ${m.file}\n  ${(error as Error).message}\n`);
      console.error(
        recorded === false
          ? "No quedó registrada, y la migración y su registro van en la misma\n" +
              "transacción: no se aplicó nada de este archivo. Corrige la causa y vuelve\n" +
              "a ejecutar: se retomará desde este mismo archivo.\n" +
              "Si lo que falló fue la conexión o un tiempo de espera —no un error de\n" +
              "PostgreSQL—, la transacción puede seguir en curso: espera unos minutos\n" +
              "antes de reintentar; si terminó, estará registrada y se saltará.\n"
          : "No se pudo comprobar si quedó aplicada. Vuelve a ejecutar cuando haya\n" +
              "conexión: si quedó, estará registrada y se saltará; si no, se aplicará.\n",
      );
      process.exit(1);
    }
    console.log("ok");
  }

  console.log(`\n✓ ${todo.length} migraciones aplicadas en ${REF}.\n`);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}\n`);
  process.exit(1);
});
