#!/usr/bin/env node
/**
 * Pone la base de producción al día, con el orden correcto y sin adivinar.
 *
 *   node scripts/poner-al-dia.mjs                      (revisa; no toca nada)
 *   node scripts/poner-al-dia.mjs --aplicar 0036 0038  (aplica SOLO esas)
 *
 * POR QUÉ EXISTE: el estado de producción se había separado del repositorio sin
 * que nada lo notara. El código de la aplicación ya consultaba
 * `meal_serving_record_items` —tabla que crea la 0036— mientras esa migración
 * seguía sin aplicarse. La despensa y las compras reventaban contra la base
 * real y las 865 pruebas seguían en verde, porque el arnés levanta su propio
 * Postgres CON esa migración adentro.
 *
 * QUÉ APORTA: el ORDEN. No es alfabético. La 0036 va DESPUÉS de la 0037, porque
 * cuando se escribió, las 0033-0035 y la 0037 ya estaban en producción. Ese
 * orden vive en la lista `MIGRACIONES` del arnés de pruebas y de ahí se lee:
 * así lo que se aplica es exactamente la secuencia que las pruebas ejercitan.
 * Si los dos se separan, las pruebas dejan de probar lo que va a correr.
 *
 * POR QUÉ SE PIDEN EXPLÍCITAS Y NO "APLICA LO QUE FALTE": porque NO EXISTE un
 * registro de migraciones aplicadas en ninguna base. La única fuente de verdad
 * es `docs/deployment/pending-supabase-migrations.md`, escrito a mano. Sin ese
 * registro este script no puede saber qué falta, y deducirlo mal sobre una base
 * clínica es peor que pedir la lista. La primera versión de este archivo
 * aplicaba las 38 de corrido: habría muerto en la primera, porque
 * `create table public.households` sobre una base que ya la tiene no es
 * idempotente.
 *
 * LO QUE NO HACE, a propósito:
 *
 *   · No aplica seeds de contenido. `dev_recipes_biblioteca.sql` trae 282
 *     recetas cuya nutrición es DEV_SEED —valores de referencia de desarrollo,
 *     NO datos del INTA— y su primera línea dice "no aplicar en producción sin
 *     revisión". Meter eso en la base que ve una familia es una decisión de
 *     producto, no un paso de mantención.
 *
 *   · No borra ni revierte nada. Las migraciones son hacia adelante.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRACIONES = path.join(RAIZ, "supabase", "migrations");
const HARNESS = path.join(RAIZ, "web", "src", "integration", "harness.ts");

const APLICAR = process.argv.includes("--aplicar");
const PEDIDAS = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"))
  .map((a) => a.trim());

/**
 * El orden sale del arnés de pruebas. Si no se puede leer, este script NO
 * adivina: se detiene. Un orden inventado sobre una base clínica es peor que no
 * correr nada.
 */
function ordenDelArnes() {
  if (!existsSync(HARNESS)) {
    throw new Error(`No encuentro ${HARNESS}. El orden sale de ahí y no se adivina.`);
  }
  const texto = readFileSync(HARNESS, "utf8");
  const bloque = texto.match(/const MIGRACIONES\s*=\s*\[([\s\S]*?)\];/);
  if (!bloque) {
    throw new Error(
      "No pude leer la lista MIGRACIONES del arnés. Si cambió de forma hay que actualizar este " +
        "script: deducir el orden por el número pondría la 0036 antes que la 0037, que es una " +
        "secuencia que ninguna prueba ejercita.",
    );
  }
  const archivos = [...bloque[1].matchAll(/"supabase\/migrations\/([^"]+)"/g)].map((m) => m[1]);
  if (archivos.length === 0) throw new Error("La lista MIGRACIONES del arnés vino vacía.");
  return archivos;
}

/** Migraciones en disco que el arnés no nombra: escritas y nunca enganchadas. */
function huerfanas(orden) {
  const enOrden = new Set(orden);
  return readdirSync(MIGRACIONES)
    .filter((f) => f.endsWith(".sql") && !enOrden.has(f))
    .sort();
}

const sha = (archivo) =>
  createHash("sha256").update(readFileSync(path.join(MIGRACIONES, archivo))).digest("hex");

const correr = (args) =>
  execFileSync("node", [path.join(RAIZ, "scripts", "aplicar-migracion.mjs"), ...args], {
    encoding: "utf8",
    cwd: RAIZ,
  });

const linea = (xs) => xs.join("\n");

// --------------------------------------------------------------------- inicio
let orden;
try {
  orden = ordenDelArnes();
} catch (e) {
  console.error(linea(["", e.message, ""]));
  process.exit(1);
}

const sueltas = huerfanas(orden);
if (sueltas.length > 0) {
  // Ruidoso a propósito: una migración escrita y no enganchada es una que
  // ninguna prueba ejercita y que este script no aplicaría nunca. El silencio
  // acá es exactamente cómo una migración de seguridad se queda sin aplicar.
  console.error(
    linea([
      "",
      `Hay ${sueltas.length} migración(es) en disco que el arnés NO nombra:`,
      ...sueltas.map((f) => `   ${f}`),
      "",
      "Agrégalas a la lista MIGRACIONES de web/src/integration/harness.ts. Mientras no estén ahí,",
      "ninguna prueba las ejercita y este script no las va a aplicar.",
      "",
    ]),
  );
  process.exit(1);
}

console.log(linea(["", `Orden de aplicación (${orden.length}, tomado del arnés de pruebas):`, ""]));
for (const f of orden) console.log(`   ${f}  ${sha(f).slice(0, 12)}…`);

/**
 * `aplicar-migracion.mjs --check` CONECTA BIEN Y DESPUÉS SE CAE AL SALIR.
 *
 * En Windows imprime "Conectado a <proyecto>: [...]" y acto seguido revienta con
 * una aserción de libuv (`!(handle->flags & UV_HANDLE_CLOSING)`) al cerrar el
 * proceso — un socket de la petición que queda abierto. El código de salida
 * queda en no-cero aunque la conexión haya sido perfecta.
 *
 * Por eso acá NO se juzga por el código de salida: se busca la marca de éxito en
 * lo que imprimió. Decir "no pude conectarme" cuando sí se conectó manda a
 * revisar el token, que es exactamente donde el problema no está.
 *
 * Es un defecto del aplicador, no de este script, y queda anotado para
 * arreglarlo ahí (le falta cerrar el proceso limpio al terminar).
 */
console.log("\nConectando…");
let conectado = false;
try {
  const salida = correr(["--check"]);
  process.stdout.write(salida);
  conectado = salida.includes("Conectado a");
} catch (e) {
  const salida = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  process.stdout.write(salida);
  conectado = salida.includes("Conectado a");
  if (conectado) {
    console.warn(
      linea([
        "",
        "(El aplicador conectó bien y se cayó al SALIR: es la aserción de libuv en Windows,",
        " no un problema de credenciales. Sigue siendo un defecto que hay que arreglar allá.)",
      ]),
    );
  } else {
    console.error(
      linea([
        "",
        `No pude conectarme: ${e.message}`,
        "El token vive en .env.deploy en la raíz del repo.",
        "",
      ]),
    );
    process.exit(1);
  }
}
if (!conectado) {
  // ERROR != VACÍO: si no salió la marca de éxito ni una excepción, no se sabe
  // si hay conexión. No se sigue adelante suponiendo que sí.
  console.error("\nNo apareció la marca de conexión y tampoco hubo error. No sigo a ciegas.\n");
  process.exit(1);
}

if (!APLICAR) {
  console.log(
    linea([
      "",
      "Esto fue solo la revisión: no se tocó nada.",
      "",
      "Para aplicar, nombra cuáles (el orden lo pone el script):",
      "",
      "   node scripts/poner-al-dia.mjs --aplicar 0036 0038",
      "",
      "Se piden explícitas porque no existe un registro de migraciones aplicadas en la base: la",
      "única fuente de verdad hoy es docs/deployment/pending-supabase-migrations.md, escrito a",
      "mano. Adivinar cuáles faltan y equivocarse deja la base a medio migrar.",
      "",
    ]),
  );
  process.exit(0);
}

if (PEDIDAS.length === 0) {
  console.error(
    linea([
      "",
      "--aplicar sin decir cuáles. Nombra los números:",
      "",
      "   node scripts/poner-al-dia.mjs --aplicar 0036 0038",
      "",
    ]),
  );
  process.exit(1);
}

// Se resuelven contra el orden del arnés: los números se pueden dar en
// cualquier orden y salen en el que de verdad hay que aplicarlos.
const pedidas = [];
for (const p of PEDIDAS) {
  const calzan = orden.filter((f) => f === p || f.startsWith(`${p}_`));
  if (calzan.length === 0) {
    console.error(`\nNo hay ninguna migración que empiece por "${p}" en la lista del arnés.\n`);
    process.exit(1);
  }
  if (calzan.length > 1) {
    console.error(`\n"${p}" calza con ${calzan.length}: ${calzan.join(", ")}. Sé más preciso.\n`);
    process.exit(1);
  }
  pedidas.push(calzan[0]);
}
const enOrden = orden.filter((f) => pedidas.includes(f));

console.log(linea(["", `Se van a aplicar ${enOrden.length}, en este orden:`, ""]));
for (const f of enOrden) console.log(`   ${f}`);
console.log("\nAplicando…\n");

let aplicadas = 0;
for (const archivo of enOrden) {
  try {
    process.stdout.write(correr([archivo]));
    aplicadas += 1;
  } catch (e) {
    // SE DETIENE A LA PRIMERA. Seguir después de una migración fallida deja la
    // base en un estado intermedio que ningún archivo del repo describe, y la
    // siguiente se aplicaría sobre un esquema que no es el que esperaba. Es
    // exactamente el escenario del que no se sale sin respaldo.
    console.error(`\nSE DETUVO en ${archivo}:\n${e.stdout ?? ""}${e.stderr ?? e.message}\n`);
    console.error(
      linea([
        `Las ${aplicadas} anteriores sí quedaron aplicadas. Arregla esta antes de seguir:`,
        "no corras las que vienen después sobre una base a medio migrar.",
        "",
      ]),
    );
    process.exit(1);
  }
}

console.log(`\nListo: ${aplicadas} migración(es) aplicada(s).\n`);
