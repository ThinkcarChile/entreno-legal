#!/usr/bin/env node
/**
 * Aplica UNA migración a Supabase por la Management API.
 *
 *   node scripts/aplicar-migracion.mjs 0030_clinical_shopping_impact.sql
 *   node scripts/aplicar-migracion.mjs ../seed/dev_catalog_seed.sql
 *   node scripts/aplicar-migracion.mjs --check        (solo credenciales)
 *   node scripts/aplicar-migracion.mjs --pendientes   (delega, ver abajo)
 *   node scripts/aplicar-migracion.mjs --ref <proyecto> 0001_family.sql   (otro proyecto: staging)
 *
 * Nace del incidente de codificación del Sprint 11: el portapapeles de Windows
 * reescribía el UTF-8 y llegaban acentos rotos a una base clínica. Este camino
 * manda los bytes del archivo TAL CUAL: antes de enviarlos comprueba que el
 * archivo sea UTF-8 limpio y sin mojibake, y deja impreso su SHA-256 para que
 * quien mire la corrida pueda comparar contra el del repo.
 *
 * (Este encabezado decía «verifica el checksum antes y después». No lo hace, y
 * no puede: la Management API no devuelve los bytes que ejecutó. Lo que hay es
 * la comprobación de arriba, que es la que atrapa el defecto real.)
 *
 * ---------------------------------------------------------------------------
 * LO QUE ESTE ARCHIVO NO SABE, Y NO VA A FINGIR QUE SABE
 *
 * 1. NO SABE EL ORDEN DE LA CADENA. Aplica el archivo que le nombran, uno.
 *    El orden real NO es el alfabético: la 0036 va DESPUÉS de la 0037, porque
 *    cuando se escribió, las 0033-0035 y la 0037 ya estaban en producción. Ese
 *    orden vive en la lista `MIGRACIONES` de `web/src/integration/harness.ts`
 *    —la misma secuencia que ejercitan las pruebas— y quien la lee y aplica en
 *    ese orden es `scripts/poner-al-dia.mjs`.
 *
 *    Este script llegó a imprimir «Para aplicarlas, en este orden:» con la
 *    lista ordenada por `readdirSync().sort()`. Eso dictaba con autoridad una
 *    secuencia que ninguna prueba ejercita: contra una base fresca o recién
 *    restaurada habría puesto la 0036 antes que la 0037.
 *
 * 2. NO SABE QUÉ TIENE PUESTO PRODUCCIÓN. Ese dato tiene un dueño declarado y
 *    probado: `supabase/estado-produccion.json` (el libro, con un testigo por
 *    migración), `scripts/verificar-estado-produccion.mjs` (le pregunta a la
 *    base real y anota lo que responde) y
 *    `web/src/integration/estado-produccion.test.ts` (prueba en PGlite que cada
 *    testigo DISCRIMINA de verdad: falso antes, verdadero después).
 *
 *    Este script tuvo su propia deducción de testigos, en paralelo y sin
 *    pruebas: los dos mecanismos ya discrepaban en 0004, 0010, 0019, 0028,
 *    0031 y 0034. Dos dueños del mismo dato es exactamente cómo el repo y
 *    producción se separaron sin que nada lo notara. Se sacó, y `--pendientes`
 *    quedó delegando en el dueño.
 * ---------------------------------------------------------------------------
 *
 * El token se lee de `.env.deploy` en la raiz (ignorado por git) o del entorno:
 *   SUPABASE_ACCESS_TOKEN=sbp_...
 * Se crea en https://supabase.com/dashboard/account/tokens y se revoca desde
 * ahí mismo cuando se quiera. NUNCA se imprime ni se guarda en el repo.
 */

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SALTO = String.fromCharCode(10);
const COMILLAS = new RegExp("^[\"']|[\"']$", "g");
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRACIONES = path.join(RAIZ, "supabase", "migrations");
const ENV_LOCAL = path.join(RAIZ, "web", ".env.local");
const VERIFICADOR = path.join(RAIZ, "scripts", "verificar-estado-produccion.mjs");

/**
 * EL TOKEN NO VIVE EN `web/.env.local`, Y ESO NO ES UNA PREFERENCIA.
 *
 * Next.js carga TODO `.env.local` dentro de `process.env` del proceso del
 * servidor web. Las `NEXT_PUBLIC_*` ademas se incrustan en el bundle del
 * navegador, pero las otras tampoco son inocuas: quedan al alcance de cada
 * server action, cada route handler y cada dependencia que corra ahi adentro.
 *
 * `SUPABASE_ACCESS_TOKEN` es un token de la Management API: puede ejecutar SQL
 * arbitrario sobre cualquier proyecto de la cuenta, incluida la base clinica.
 * La aplicacion NO lo usa — lo usa solo este script de linea de comandos. Que
 * viviera en el entorno del servidor web era darle a la app entera un poder que
 * no necesita, y cualquier volcado de entorno o traza de error lo exponia.
 *
 * Ahora vive en `.env.deploy` en la raiz (ignorado por git), que Next.js no lee
 * nunca. La URL del proyecto si puede seguir saliendo de `web/.env.local`: es
 * publica y viaja en el bundle del navegador de todas formas.
 */
const ENV_DESPLIEGUE = path.join(RAIZ, ".env.deploy");

/** Lee una variable de un archivo de entorno sin volcarlo a memoria global. */
function delArchivo(archivo, clave) {
  if (!existsSync(archivo)) return null;
  for (const linea of readFileSync(archivo, "utf8").split(SALTO)) {
    const limpia = linea.trim();
    if (limpia.startsWith("#") || !limpia.includes("=")) continue;
    const i = limpia.indexOf("=");
    if (limpia.slice(0, i).trim() === clave) {
      return limpia.slice(i + 1).trim().replace(COMILLAS, "");
    }
  }
  return null;
}

const delEnvLocal = (clave) => delArchivo(ENV_LOCAL, clave);

/**
 * `--ref <proyecto>` (o `--ref=<proyecto>`): a qué proyecto de Supabase hablarle.
 *
 * SIN la opción, el ref sale de NEXT_PUBLIC_SUPABASE_URL como siempre: ese es el
 * comportamiento por defecto y NO cambia. La opción existe para STAGING
 * (`scripts/staging-bootstrap.mjs` la pasa en cada llamada). Antes, la única
 * forma de apuntar este script a otro proyecto era editar web/.env.local —o sea
 * desconfigurar la app de desarrollo para configurar un script— y dejarla
 * apuntando a staging por accidente hasta que alguien lo notara.
 *
 * Devuelve el ref y los argumentos restantes SIN `--ref` ni su valor: si el
 * valor quedara en la lista, el posicional siguiente sería "el archivo".
 *
 * Un `--ref` sin valor NO cae al proyecto por defecto: caer a producción por
 * un argumento a medio escribir es exactamente el accidente que la opción vino
 * a evitar. Se corta con error.
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

/**
 * Corta la corrida con un código de salida, SIN `process.exit()`.
 *
 * `process.exit()` mata el proceso con el socket de `fetch` todavía abierto, y
 * en Windows eso revienta libuv («!(handle->flags & UV_HANDLE_CLOSING)»): el
 * proceso muere con 127 y se pierde el código que este script quería devolver.
 * Quien lo llama desde afuera no puede distinguir «la migración falló» de «el
 * proceso reventó»; `scripts/poner-al-dia.mjs` tuvo que aprender a juzgar por
 * el texto impreso en vez de por el código de salida.
 *
 * Con la excepción, Node termina de cerrar lo suyo y recién ahí se va, con el
 * código correcto.
 */
class SalidaLimpia extends Error {
  constructor(codigo) {
    super(`salida ${codigo}`);
    this.codigo = codigo;
  }
}

function salir(mensaje, codigo = 1) {
  console.error(mensaje);
  throw new SalidaLimpia(codigo);
}

/**
 * Token + ref del proyecto, o corta explicando cuál de los dos falta.
 *
 * `refExplicito` es el de `--ref`; con él puesto no se mira ninguna URL de
 * entorno, así que apuntar a staging no depende de cómo esté web/.env.local.
 */
function credenciales(refExplicito = null) {
  const token =
    process.env.SUPABASE_ACCESS_TOKEN ?? delArchivo(ENV_DESPLIEGUE, "SUPABASE_ACCESS_TOKEN");

  // Si el token quedo en el .env de la web se avisa fuerte, en vez de usarlo en
  // silencio: seguir funcionando sin decir nada lo dejaria expuesto para siempre,
  // porque nada volveria a recordarlo.
  if (!token && delEnvLocal("SUPABASE_ACCESS_TOKEN")) {
    salir(
      [
        "",
        "El token esta en web/.env.local, que Next.js carga en el proceso del servidor web.",
        "Muevelo a .env.deploy en la raiz del repo (ignorado por git) y borralo de alla:",
        "",
        "  SUPABASE_ACCESS_TOKEN=sbp_...",
        "",
        "Ese token corre SQL arbitrario sobre toda la cuenta; la app web no lo necesita.",
        "",
      ].join(SALTO),
    );
  }

  if (!token) {
    salir(
      [
        "Falta el token de la Management API.",
        "",
        "  1. Ve a https://supabase.com/dashboard/account/tokens",
        "  2. «Generate new token», nómbralo por ejemplo `claude-code-migraciones`",
        "  3. Pega el valor en .env.deploy, en la RAÍZ del repo (no en web/.env.local:",
        "     ese archivo lo carga Next.js dentro del servidor web), como una línea nueva:",
        "",
        "       SUPABASE_ACCESS_TOKEN=sbp_...",
        "",
        "El archivo está ignorado por git. El token se revoca desde esa misma página.",
      ].join(SALTO),
    );
  }

  if (refExplicito) return { token, ref: refExplicito, origenDelRef: "--ref" };

  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    delArchivo(ENV_DESPLIEGUE, "NEXT_PUBLIC_SUPABASE_URL") ??
    delEnvLocal("NEXT_PUBLIC_SUPABASE_URL") ??
    "";
  const ref = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? null;
  if (!ref) salir("No se pudo deducir el ref del proyecto desde NEXT_PUBLIC_SUPABASE_URL.");

  return { token, ref, origenDelRef: "NEXT_PUBLIC_SUPABASE_URL" };
}

/** Ejecuta SQL en el proyecto. Devuelve las filas que la consulta produzca. */
async function ejecutar({ token, ref }, sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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

/**
 * `--pendientes` DELEGA: acá no hay una segunda respuesta a esa pregunta.
 *
 * Se conserva el nombre del comando porque está en la memoria de los dedos y en
 * documentos viejos, y mandar a alguien a un «Uso:» pelado existiendo la
 * herramienta correcta es hacerle perder el viaje. Lo que no se conserva es una
 * segunda deducción del mismo dato.
 *
 * El código de salida es EL DEL VERIFICADOR, tal cual, sin reinterpretarlo: 0 si
 * el libro y la base dicen lo mismo, 2 si discrepan, 1 si no pudo preguntar.
 * Traducirlo acá sería inventar un tercer criterio sobre el mismo dato.
 */
function delegarPendientes(extra) {
  console.error(
    [
      "",
      "«--pendientes» lo contesta scripts/verificar-estado-produccion.mjs, que es el dueño de",
      "ese dato (libro supabase/estado-produccion.json + testigos probados en",
      "web/src/integration/estado-produccion.test.ts). Te lo corro:",
      "",
    ].join(SALTO),
  );

  const r = spawnSync(process.execPath, [VERIFICADOR, ...extra], { stdio: "inherit" });
  if (r.error) salir(`No pude correr ${VERIFICADOR}: ${r.error.message}`);

  // Un proceso muerto por una señal no trae código de salida. Devolver 0 ahí
  // sería decir «todo en orden» sin haber leído nada: no se sabe, y se dice.
  if (typeof r.status !== "number") {
    salir(
      `verificar-estado-produccion.mjs terminó sin código de salida (señal ${
        r.signal ?? "desconocida"
      }). No sé cómo le fue.`,
    );
  }
  process.exitCode = r.status;
}

async function aplicarArchivo(arg, refExplicito) {
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

  const creds = credenciales(refExplicito);

  console.log(`Aplicando ${path.basename(ruta)}`);
  console.log(`  SHA-256: ${sha}`);
  // Se dice DE DÓNDE salió el ref: quien lee la corrida tiene que poder ver si
  // fue a producción por defecto o a otro proyecto por --ref.
  console.log(`  Proyecto: ${creds.ref} (${creds.origenDelRef})`);

  try {
    const resultado = await ejecutar(creds, sql);
    console.log("OK — aplicada.");
    if (Array.isArray(resultado) && resultado.length > 0) {
      console.log(
        `  Devolvió ${resultado.length} fila(s): ${JSON.stringify(resultado.slice(0, 3))}`,
      );
    }
  } catch (e) {
    salir(`FALLÓ: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function principal() {
  let ref = null;
  let resto = [];
  try {
    ({ ref, resto } = extraerRef(process.argv.slice(2)));
  } catch (e) {
    salir(e instanceof Error ? e.message : String(e));
  }
  const arg = resto[0];

  if (arg === "--check") {
    const creds = credenciales(ref);
    try {
      const filas = await ejecutar(creds, "select current_database() as db, version() as v");
      console.log(`Conectado a ${creds.ref} (${creds.origenDelRef}): ${JSON.stringify(filas)}`);
    } catch (e) {
      // Con mensaje y sin traza: quien corre --check está averiguando si el
      // token sirve, y una pila de Node no le contesta esa pregunta.
      salir(`No pude conectarme al proyecto ${creds.ref}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (arg === "--pendientes") {
    // El --ref viaja al verificador tal cual: contra otro proyecto, él informa
    // y se niega a escribir el libro (que describe producción).
    delegarPendientes([...resto.slice(1), ...(ref ? ["--ref", ref] : [])]);
    return;
  }

  if (!arg) {
    salir(
      [
        "Uso: node scripts/aplicar-migracion.mjs <archivo.sql> | --check | --pendientes  [--ref <proyecto>]",
        "",
        "--ref apunta a OTRO proyecto (staging). Sin --ref va al de NEXT_PUBLIC_SUPABASE_URL.",
        "",
        "Este script aplica UN archivo. Para la cadena, en el orden real (que no es el",
        "alfabético: la 0036 va después de la 0037): node scripts/poner-al-dia.mjs",
        "Para saber qué tiene puesto producción: node scripts/verificar-estado-produccion.mjs",
      ].join(SALTO),
    );
  }

  await aplicarArchivo(arg, ref);
}

try {
  await principal();
} catch (e) {
  if (e instanceof SalidaLimpia) {
    process.exitCode = e.codigo;
  } else {
    console.error(`Error inesperado: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 1;
  }
}
