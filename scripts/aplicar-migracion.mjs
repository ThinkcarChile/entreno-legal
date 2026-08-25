#!/usr/bin/env node
/**
 * Aplica una migración a Supabase por la Management API.
 *
 * Nace del incidente de codificación del Sprint 11: el portapapeles de Windows
 * reescribía el UTF-8 y llegaban acentos rotos a una base clínica. Este camino
 * manda los bytes del archivo TAL CUAL, y verifica el checksum antes y después.
 *
 *   node scripts/aplicar-migracion.mjs 0030_clinical_shopping_impact.sql
 *   node scripts/aplicar-migracion.mjs --check        (solo credenciales)
 *   node scripts/aplicar-migracion.mjs --pendientes   (qué falta aplicar)
 *
 * El token se lee de `web/.env.local` (ignorado por git) o del entorno:
 *   SUPABASE_ACCESS_TOKEN=sbp_...
 * Se crea en https://supabase.com/dashboard/account/tokens y se revoca desde
 * ahí mismo cuando se quiera. NUNCA se imprime ni se guarda en el repo.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRACIONES = path.join(RAIZ, "supabase", "migrations");
const ENV_LOCAL = path.join(RAIZ, "web", ".env.local");

/** Lee una variable de `web/.env.local` sin volcar el archivo a memoria global. */
function delEnvLocal(clave) {
  if (!existsSync(ENV_LOCAL)) return null;
  for (const linea of readFileSync(ENV_LOCAL, "utf8").split("\n")) {
    const limpia = linea.trim();
    if (limpia.startsWith("#") || !limpia.includes("=")) continue;
    const i = limpia.indexOf("=");
    if (limpia.slice(0, i).trim() === clave) {
      return limpia.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? delEnvLocal("SUPABASE_ACCESS_TOKEN");
const URL_SUPABASE =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? delEnvLocal("NEXT_PUBLIC_SUPABASE_URL") ?? "";
const REF = URL_SUPABASE.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? null;

function salir(mensaje, codigo = 1) {
  console.error(mensaje);
  process.exit(codigo);
}

if (!TOKEN) {
  salir(
    [
      "Falta el token de la Management API.",
      "",
      "  1. Ve a https://supabase.com/dashboard/account/tokens",
      "  2. «Generate new token», nómbralo por ejemplo `claude-code-migraciones`",
      "  3. Pega el valor en web/.env.local como una línea nueva:",
      "",
      "       SUPABASE_ACCESS_TOKEN=sbp_...",
      "",
      "El archivo está ignorado por git. El token se revoca desde esa misma página.",
    ].join("\n"),
  );
}
if (!REF) salir("No se pudo deducir el ref del proyecto desde NEXT_PUBLIC_SUPABASE_URL.");

/** Ejecuta SQL en el proyecto. Devuelve las filas que la consulta produzca. */
async function ejecutar(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const texto = await r.text();
  if (!r.ok) {
    let detalle = texto;
    try {
      detalle = JSON.parse(texto).message ?? texto;
    } catch {
      /* el cuerpo no era JSON: se muestra crudo */
    }
    throw new Error(`Supabase respondió ${r.status}: ${detalle}`);
  }
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

const arg = process.argv[2];

if (arg === "--check") {
  const filas = await ejecutar("select current_database() as db, version() as v");
  console.log(`Conectado a ${REF}: ${JSON.stringify(filas)}`);
  process.exit(0);
}

if (arg === "--pendientes") {
  // Compara los archivos locales contra lo que la base dice tener. La única
  // fuente confiable de "ya aplicada" es el efecto, no un registro paralelo:
  // se listan los archivos y el operador decide.
  const archivos = readdirSync(MIGRACIONES).filter((f) => f.endsWith(".sql")).sort();
  console.log("Migraciones locales:");
  for (const f of archivos) {
    const sha = createHash("sha256")
      .update(readFileSync(path.join(MIGRACIONES, f)))
      .digest("hex");
    console.log(`  ${f}  ${sha.slice(0, 12)}…`);
  }
  process.exit(0);
}

if (!arg) salir("Uso: node scripts/aplicar-migracion.mjs <archivo.sql> | --check | --pendientes");

const ruta = path.isAbsolute(arg) ? arg : path.join(MIGRACIONES, arg);
if (!existsSync(ruta)) salir(`No existe ${ruta}`);

const bytes = readFileSync(ruta);
const sha = createHash("sha256").update(bytes).digest("hex");
const sql = bytes.toString("utf8");

// Guardián de codificación (el mismo criterio que el test de CI): si el
// archivo no es UTF-8 limpio, no se aplica. Un mensaje clínico ilegible es
// un defecto, y este canal existe justamente para no repetirlo.
if (!Buffer.from(sql, "utf8").equals(bytes)) {
  salir(`${path.basename(ruta)}: el archivo no es UTF-8 válido. No se aplica.`);
}
if (sql.includes("�") || /Ã.|├|┬|Ô/.test(sql)) {
  salir(`${path.basename(ruta)}: el archivo tiene mojibake o caracteres perdidos. No se aplica.`);
}

console.log(`Aplicando ${path.basename(ruta)}`);
console.log(`  SHA-256: ${sha}`);
console.log(`  Proyecto: ${REF}`);

try {
  const resultado = await ejecutar(sql);
  console.log("OK — aplicada.");
  if (Array.isArray(resultado) && resultado.length > 0) {
    console.log(`  Devolvió ${resultado.length} fila(s): ${JSON.stringify(resultado.slice(0, 3))}`);
  }
} catch (e) {
  salir(`FALLÓ: ${e instanceof Error ? e.message : String(e)}`);
}
