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
 * QUÉ APLICAR: se puede nombrar a mano, o pedir `--pendientes`.
 *
 * Durante mucho tiempo acá decía que había que nombrarlas SIEMPRE, porque no
 * existía ningún registro de migraciones aplicadas y la única fuente era
 * `docs/deployment/pending-supabase-migrations.md`, escrito a mano. Eso dejó de
 * ser cierto: `supabase/estado-produccion.json` es un libro legible por máquina
 * donde cada migración declara un TESTIGO —una expresión SQL falsa antes de
 * aplicarla y verdadera después— y `verificar-estado-produccion.mjs` se los
 * pregunta A LA BASE REAL. No es un registro paralelo que alguien deba acordarse
 * de actualizar: es la base contestando qué tiene puesto.
 *
 * `--pendientes` usa ese libro. No es una comodidad menor: la alternativa era
 * tipear diecinueve números a mano contra una base con datos de una familia, y
 * equivocarse en uno deja la cadena a medio migrar.
 *
 * Lo que NO hace es adivinar. Si el libro no fue verificado contra la base en
 * vivo, o su verificación caducó, `--pendientes` se niega y manda a correr la
 * comprobación, que toma un minuto. Un libro viejo no es conocimiento, es un
 * recuerdo — y sobre una base clínica esa diferencia importa.
 *
 * (Nombrarlas a mano sigue funcionando igual, y sigue siendo lo correcto cuando
 * se quiere aplicar sólo una parte de lo que falta.)
 *
 * La primera versión de este archivo aplicaba las 38 de corrido: habría muerto
 * en la primera, porque `create table public.households` sobre una base que ya
 * la tiene no es idempotente.
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
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRACIONES = path.join(RAIZ, "supabase", "migrations");
const HARNESS = path.join(RAIZ, "web", "src", "integration", "harness.ts");

const APLICAR = process.argv.includes("--aplicar");
const PENDIENTES = process.argv.includes("--pendientes");
const SELLAR = process.argv.includes("--sellar");
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

const LIBRO = path.join(RAIZ, "supabase", "estado-produccion.json");

/**
 * Las que el libro declara PENDIENTE, en el orden del arnés.
 *
 * La guarda es DELIBERADAMENTE MÁS ESTRICTA que la del módulo que gobierna la
 * vigencia del libro (`web/src/integration/estado-produccion.ts`, con su techo
 * por método y sus 90 días). Acá no se reimplementa esa política —dos dueños de
 * la misma regla terminan discrepando— sino que se exige un subconjunto que no
 * admite interpretación: que el estado se haya sacado preguntándole a la base
 * (`TESTIGOS_EN_VIVO`) y que esa pregunta siga vigente.
 *
 * La asimetría es a propósito. Este script ESCRIBE en una base con datos reales;
 * el gate sólo lee. Negarse de más cuesta un minuto de verificación; aceptar de
 * menos cuesta una cadena a medio aplicar.
 */
function pendientesDelLibro(orden) {
  if (!existsSync(LIBRO)) {
    throw new Error(`No encuentro ${LIBRO}. Sin el libro no se sabe qué falta y no se adivina.`);
  }
  const libro = JSON.parse(readFileSync(LIBRO, "utf8"));

  if (libro.metodo !== "TESTIGOS_EN_VIVO") {
    throw new Error(
      linea([
        `El libro dice metodo="${libro.metodo}", no TESTIGOS_EN_VIVO: su estado NO salió de`,
        "preguntarle a la base. Corre primero:",
        "",
        "   node scripts/verificar-estado-produccion.mjs --escribir",
      ]),
    );
  }
  const hoy = new Date().toISOString().slice(0, 10);
  if (!libro.caduca_el || libro.caduca_el < hoy) {
    throw new Error(
      linea([
        `La verificación del libro caducó (caduca_el=${libro.caduca_el}, hoy=${hoy}).`,
        "Un libro vencido es un recuerdo, no conocimiento. Corre:",
        "",
        "   node scripts/verificar-estado-produccion.mjs --escribir",
      ]),
    );
  }

  const estados = libro.migraciones ?? {};
  // Toda migración de la cadena tiene que tener entrada. Una sin entrada es de
  // estado DESCONOCIDO, y desconocido no se puede tratar como "ya aplicada":
  // saltársela dejaría la cadena con un hueco en el medio.
  const sinEntrada = orden.filter((f) => estados[f] === undefined);
  if (sinEntrada.length > 0) {
    throw new Error(
      linea([
        `${sinEntrada.length} migración(es) de la cadena no tienen entrada en el libro:`,
        ...sinEntrada.map((f) => `   ${f}`),
        "",
        "Su estado es DESCONOCIDO. Agrégales su testigo antes de aplicar nada.",
      ]),
    );
  }
  return orden.filter((f) => estados[f].estado === "PENDIENTE");
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
  // RUIDOSO SÍ, PERO NO UN PORTAZO. Y la diferencia la enseñó este mismo
  // script: la primera versión se DETENÍA acá, y el día que hubo que aplicar
  // urgente la 0036 y la 0038 —las dos correctamente enganchadas y probadas—
  // se nego a hacerlo porque OTRAS quince migraciones estaban a medio escribir
  // en tres frentes en paralelo. El guardián tomó de rehén un trabajo válido
  // por el estado de un trabajo ajeno.
  //
  // Lo que de verdad hay que impedir es aplicar algo que ninguna prueba
  // ejercita, y eso ya está impedido aguas abajo: los números pedidos se
  // resuelven CONTRA la lista del arnés, así que pedir una migración suelta
  // falla con nombre y apellido. Acá alcanza con avisar fuerte, porque el
  // riesgo real de una migración sin enganchar es quedarse sin aplicar en
  // silencio — y este aviso es justamente lo que rompe el silencio.
  console.warn(
    linea([
      "",
      `AVISO: hay ${sueltas.length} migración(es) en disco que el arnés NO nombra:`,
      ...sueltas.map((f) => `   ${f}`),
      "",
      "Ninguna prueba las ejercita y este script no las va a aplicar. Cuando estén listas,",
      "agrégalas a la lista MIGRACIONES de web/src/integration/harness.ts.",
      "",
    ]),
  );
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
// SELLAR NO TOCA LA BASE: es leer archivos y anotar su checksum en el libro.
// Va antes de conectarse para que se pueda sellar sin credenciales y sin red
// y, sobre todo, para que no dependa de que produccion este contestando.
if (SELLAR) {
  sellar(orden);
  process.exit(0);
}

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

/**
 * QUÉ SE VA A APLICAR. Se resuelve IGUAL en modo informe y se muestra: el plan
 * completo se puede ver sin autorizar nada, que es exactamente lo que hace falta
 * para decidir si autorizarlo.
 */
let plan = null;
let motivoDelPlan = "";

if (PENDIENTES) {
  try {
    plan = pendientesDelLibro(orden);
    motivoDelPlan = "lo que el libro declara PENDIENTE, preguntado a la base en vivo";
  } catch (e) {
    console.error(linea(["", e.message, ""]));
    process.exit(1);
  }
  if (plan.length === 0) {
    console.log(linea(["", "El libro no declara ninguna pendiente: no hay nada que aplicar.", ""]));
    process.exit(0);
  }
} else if (PEDIDAS.length > 0) {
  // Se resuelven contra el orden del arnés: los números se pueden dar en
  // cualquier orden y salen en el que de verdad hay que aplicarlos.
  const pedidas = [];
  for (const q of PEDIDAS) {
    const calzan = orden.filter((f) => f === q || f.startsWith(`${q}_`));
    if (calzan.length === 0) {
      console.error(linea(["", `No hay ninguna migración que empiece por "${q}" en el arnés.`, ""]));
      process.exit(1);
    }
    if (calzan.length > 1) {
      console.error(linea(["", `"${q}" calza con ${calzan.length}: ${calzan.join(", ")}.`, ""]));
      process.exit(1);
    }
    pedidas.push(calzan[0]);
  }
  plan = orden.filter((f) => pedidas.includes(f));
  motivoDelPlan = "nombradas a mano";
}

if (plan !== null) {
  console.log(linea(["", `Plan (${plan.length} — ${motivoDelPlan}), en el orden en que van:`, ""]));
  for (const f of plan) console.log(`   ${f}`);
  // Se revisa ACÁ y no justo antes de escribir: el estado de los sellos es parte
  // de lo que hay que ver para decidir si autorizar, no una sorpresa que aparece
  // cuando ya se dijo que sí.
  revisarSellos(plan);
}

if (!APLICAR) {
  console.log(
    linea([
      "",
      "Esto fue sólo la revisión: no se tocó nada.",
      "",
      "Para aplicar lo que la base dice que le falta:",
      "",
      "   node scripts/poner-al-dia.mjs --pendientes --aplicar",
      "",
      "O nombrando cuáles, si se quiere sólo una parte (el orden lo pone el script):",
      "",
      "   node scripts/poner-al-dia.mjs --aplicar 0039 0040",
      "",
      "El estado sale de supabase/estado-produccion.json, donde cada migración declara un",
      "testigo que se le pregunta A LA BASE. Si esa verificación caducó, --pendientes se",
      "niega y pide correrla de nuevo en vez de adivinar.",
      "",
    ]),
  );
  process.exit(0);
}

/**
 * EL SELLO: que lo que se aplique sea EXACTAMENTE lo que se revisó.
 *
 * El documento de despliegue dice desde siempre que una migración listada como
 * pendiente está CONGELADA y que el checksum sirve para comprobarlo. Faltaba
 * quien lo comprobara: acá se calculaba el sha para IMPRIMIRLO y nada más.
 *
 * No es una preocupación de manual. Estas diecinueve las estuvieron escribiendo
 * tres frentes en paralelo durante el mismo día en que se iban a aplicar; entre
 * "las revisé" y "las apliqué" cabe perfectamente una edición.
 *
 * La regla es asimétrica a propósito:
 *   · Con checksum en el libro y DISTINTO al del archivo: se detiene. El archivo
 *     cambió después de sellarse y nadie sabe qué trae de nuevo.
 *   · Sin checksum en el libro: avisa fuerte y sigue. Una migración recién
 *     escrita todavía no está sellada, y negarse ahí dejaría el despliegue
 *     rehén de un trámite en vez de protegerlo de un cambio real.
 */
function revisarSellos(archivos) {
  const libro = existsSync(LIBRO) ? JSON.parse(readFileSync(LIBRO, "utf8")) : { migraciones: {} };
  const rotos = [];
  const sinSellar = [];
  for (const f of archivos) {
    const esperado = libro.migraciones?.[f]?.sha256;
    if (!esperado) {
      sinSellar.push(f);
      continue;
    }
    const real = sha(f);
    if (real !== esperado) rotos.push({ f, esperado, real });
  }
  if (rotos.length > 0) {
    console.error(
      linea([
        "",
        "EL ARCHIVO CAMBIÓ DESPUÉS DE SELLARSE. No se aplica nada:",
        "",
        ...rotos.map((r) => `   ${r.f}`),
        ...rotos.map((r) => `      libro ${r.esperado.slice(0, 16)}…  archivo ${r.real.slice(0, 16)}…`),
        "",
        "Lo que se iba a aplicar NO es lo que se revisó. Revisa el cambio y vuelve a sellar:",
        "",
        "   node scripts/poner-al-dia.mjs --sellar",
        "",
      ]),
    );
    process.exit(1);
  }
  if (sinSellar.length > 0) {
    console.warn(
      linea([
        "",
        `AVISO: ${sinSellar.length} de las que se van a aplicar no tienen checksum en el libro.`,
        "Nada garantiza que sean las que se revisaron. Para sellarlas tal como están hoy:",
        "",
        "   node scripts/poner-al-dia.mjs --sellar",
        "",
      ]),
    );
  }
}

/**
 * Anota en el libro el sha256 de cada migración que no lo tenga, y ACTUALIZA el
 * de las PENDIENTES que hayan cambiado desde que se sellaron.
 *
 * La primera versión sólo rellenaba lo que faltaba, y eso dejaba un callejón sin
 * salida real: sellar las diecinueve, encontrar un defecto en una, arreglarlo, y
 * quedarse sin forma de volver a sellarla — el guardián se quejaba para siempre
 * y no había comando que lo resolviera. Un candado sin llave no es seguridad, es
 * una puerta rota.
 *
 * Una APLICADA que cambió NO se re-sella acá, ni con esta bandera ni con
 * ninguna. Producción tiene puesto ese archivo; volver a sellarlo sólo borraría
 * la señal de que el repo y la base dejaron de ser lo mismo, que es exactamente
 * la que hay que ver. Eso se arregla con una migración nueva.
 */
function sellar(archivos) {
  const libro = JSON.parse(readFileSync(LIBRO, "utf8"));
  const puestos = [];
  const cambiadas = [];
  const intocables = [];
  for (const f of archivos) {
    const e = libro.migraciones?.[f];
    if (e === undefined) continue;
    const real = sha(f);
    if (!e.sha256) {
      e.sha256 = real;
      puestos.push(f);
      continue;
    }
    if (e.sha256 === real) continue;
    if (e.estado === "APLICADA") {
      intocables.push(f);
      continue;
    }
    e.sha256 = real;
    cambiadas.push(f);
  }
  if (intocables.length > 0) {
    console.error(
      linea([
        "",
        "NO SE RE-SELLAN, PORQUE PRODUCCIÓN LAS TIENE PUESTAS:",
        "",
        ...intocables.map((f) => `   ${f}`),
        "",
        "Que una aplicada cambie significa que el repo dejó de describir la base. Volver a",
        "sellarla taparía justo la señal que hay que ver. El arreglo va en una migración",
        "NUEVA, y el archivo viejo se deja como estaba.",
        "",
      ]),
    );
    process.exit(1);
  }
  if (cambiadas.length > 0) {
    console.log(
      linea([
        "",
        `Re-selladas ${cambiadas.length} que habían cambiado desde el sello anterior:`,
        "",
        ...cambiadas.map((f) => `   ${f}`),
      ]),
    );
  }
  puestos.push(...cambiadas);
  if (puestos.length === 0) {
    console.log(linea(["", "Todas las de la cadena ya tenían su checksum. No se tocó el libro.", ""]));
    return;
  }
  writeFileSync(LIBRO, `${JSON.stringify(libro, null, 2)}
`, "utf8");
  console.log(linea(["", `Selladas ${puestos.length}:`, "", ...puestos.map((f) => `   ${f}`), ""]));
}

if (plan === null) {
  console.error(
    linea([
      "",
      "--aplicar sin decir qué. Las dos formas:",
      "",
      "   node scripts/poner-al-dia.mjs --pendientes --aplicar   (lo que la base dice que falta)",
      "   node scripts/poner-al-dia.mjs --aplicar 0039 0040      (sólo esas)",
      "",
    ]),
  );
  process.exit(1);
}

const enOrden = plan;

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
