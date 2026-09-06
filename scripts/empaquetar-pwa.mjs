#!/usr/bin/env node
/**
 * Empaqueta la PWA para ALOJARLA EN UN SERVIDOR PROPIO: compila, arma el
 * standalone completo, estampa la versión del service worker, VALIDA y deja un
 * zip listo para subir.
 *
 *   cd web
 *   npm run pwa:empaquetar               # compila + arma + valida + zip
 *   npm run pwa:empaquetar -- --limpio   # antes borra .next y corre `npm ci`
 *   npm run pwa:validar                  # valida el bundle ya armado, sin compilar
 *
 * DESDE UN CHECKOUT LIMPIO (reproducible, sin nada instalado):
 *
 *   git clone <repo> && cd entreno-legal/web
 *   npm run pwa:empaquetar -- --limpio
 *
 * `npm run` no necesita node_modules para arrancar este script (solo usa
 * módulos de Node), y `--limpio` instala desde el lockfile antes de compilar.
 * Hace falta `web/.env.local` con NEXT_PUBLIC_SUPABASE_URL y
 * NEXT_PUBLIC_SUPABASE_ANON_KEY: `next build` HORNEA esos dos valores dentro del
 * bundle del cliente, así que el proyecto con el que se compila tiene que ser el
 * mismo al que apunta el servidor. Si faltan, el script se niega a compilar.
 *
 * QUÉ PRODUCE (en `dist/` en la raíz del repo, ignorado por git):
 *   - nutrifamilia-pwa-<sha>.zip        el bundle entero; se sube y se descomprime tal cual
 *   - VARIABLES-DE-ENTORNO.md           qué variables necesita el servidor, y cuál JAMÁS
 *
 * POR QUÉ EXISTE. El standalone de Next NO se basta solo: deja fuera
 * `.next/static` y `public/`, y sin ellos la app carga sin estilos, sin iconos
 * y sin PWA instalable. Antes eran tres `cp -r` escritos en un documento, o sea
 * tres oportunidades de subir un bundle cojo sin que nada avisara. Acá el
 * armado es un solo comando y la validación FALLA si falta cualquier pieza.
 *
 * POR QUÉ SE ESTAMPA LA VERSIÓN DEL SERVICE WORKER. `public/sw.js` nombra sus
 * cachés con `VERSION`, y en el fuente es el literal "v1" que ningún build
 * subía: al cambiar el color de marca, cualquiera que ya tuviera la app
 * instalada quedaba con el icono viejo pegado hasta borrar los datos del sitio.
 * Ahora cada empaquetado reemplaza ese literal EN LA COPIA del bundle por
 * `<version de package.json>-<sha corto>`: el fuente sigue diciendo "v1" (es el
 * marcador que este script busca, y `web/src/lib/pwa.test.ts` vigila que exista
 * exactamente una vez), y cada despliegue nuevo estrena nombres de caché, así
 * que el `activate` del worker bota los del despliegue anterior.
 *
 * ÁRBOL SUCIO. Si `git status` tiene cambios, el sha no describe lo que se
 * compiló: la estampa y el nombre del zip llevan `-sucio` y la estampa además
 * lleva la fecha-hora, para que dos empaquetados sucios seguidos no compartan
 * nombre de caché. Se declara, no se esconde.
 *
 * ZIP SIN DEPENDENCIAS NUEVAS. En Windows se usa `tar.exe` de System32 (bsdtar,
 * viene con Windows 10+; escribe zip con `-a`). NO se usa `Compress-Archive` de
 * PowerShell 5.1: escribe las rutas con barra invertida y al descomprimir en un
 * servidor Linux salen archivos llamados `.next\static\...` en la raíz. En
 * Linux/macOS se usa `zip`, y si no está, bsdtar. El zip se LISTA después de
 * crearlo y se comprueba que trae `server.js` y ninguna barra invertida.
 *
 * Las funciones puras van exportadas para que el test las ejecute contra los
 * archivos reales del repo; `principal()` solo corre cuando el script se invoca
 * directo.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(RAIZ, "web");
const NEXT_DIR = path.join(WEB, ".next");
const STANDALONE = path.join(NEXT_DIR, "standalone");
const DIST = path.join(RAIZ, "dist");

/**
 * El marcador EXACTO que se busca en public/sw.js. Si alguien lo reescribe
 * (comillas simples, `let`, otro valor), el estampado falla FUERTE en vez de
 * dejar pasar un bundle con "v1" para siempre: pwa.test.ts lo vigila en el
 * fuente y `validarBundle` en la copia.
 */
export const MARCADOR_VERSION = 'const VERSION = "v1";';

/** Variables que el servidor NECESITA. La lista vive acá y el .md se genera de ella. */
export const VARIABLES_OBLIGATORIAS = [
  {
    nombre: "NEXT_PUBLIC_SUPABASE_URL",
    valor:
      "https://<proyecto>.supabase.co — la MISMA con la que se compiló (queda horneada en el cliente)",
  },
  {
    nombre: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    valor: "la anon key pública del mismo proyecto (también horneada al compilar)",
  },
  { nombre: "PORT", valor: "el puerto que asigne el hosting (Passenger la define sola)" },
  {
    nombre: "HOSTNAME",
    valor:
      "0.0.0.0 salvo que el hosting exija otra interfaz; sin ella server.js usa su valor por omisión",
  },
  { nombre: "NODE_ENV", valor: "production" },
];

/** Opcionales: sin ellas el asistente corre en modo `fake` (provider.ts lo decide). */
export const VARIABLES_OPCIONALES = [
  {
    nombre: "ASSISTANT_PROVIDER",
    valor: "`remoto` para usar un proveedor de IA real; cualquier otra cosa = fake",
  },
  { nombre: "ASSISTANT_API_URL", valor: "URL del proveedor (solo con ASSISTANT_PROVIDER=remoto)" },
  { nombre: "ASSISTANT_API_KEY", valor: "clave del proveedor (solo con ASSISTANT_PROVIDER=remoto)" },
  { nombre: "ASSISTANT_MODEL", valor: "modelo del proveedor (opcional)" },
  {
    nombre: "SITE_URL",
    valor:
      "URL publica del sitio, sin barra final (p. ej. https://familia.ejemplo.cl). " +
      "La usan los correos de Auth para volver a /auth/callback y el enlace de invitacion. " +
      "Opcional en el codigo, OBLIGATORIA en produccion: sin ella se deduce del Host, que un proxy puede mentir",
  },
  {
    nombre: "HOGAR_CREACION_ABIERTA",
    valor: "`1` permite crear hogares nuevos desde /family. Cerrado por omision: la beta entra solo por invitacion",
  },
];

/** Lo que JAMÁS va en el servidor web. */
export const VARIABLES_PROHIBIDAS = [
  {
    nombre: "SUPABASE_ACCESS_TOKEN",
    porque:
      "token de la Management API: corre SQL arbitrario sobre TODA la cuenta. Vive en `.env.deploy` en la raíz, ignorado por git, y la app no lo necesita nunca",
  },
  {
    nombre: "SUPABASE_SERVICE_ROLE_KEY",
    porque:
      "salta las políticas RLS; la app no la usa y en el servidor web sería una llave maestra esperando que la filtren",
  },
];

/** Iconos PNG que Chrome exige para ofrecer la instalación, por lado y propósito. */
const ICONOS_EXIGIDOS = [
  { sizes: "192x192", purpose: "any" },
  { sizes: "512x512", purpose: "any" },
  { sizes: "192x192", purpose: "maskable" },
  { sizes: "512x512", purpose: "maskable" },
];

/* ------------------------------------------------------------------ */
/* Funciones puras (las ejecuta el test)                                */
/* ------------------------------------------------------------------ */

/** Cuántas veces aparece el marcador exacto en el fuente del worker. */
export function vecesQueApareceElMarcador(fuenteSw) {
  return fuenteSw.split(MARCADOR_VERSION).length - 1;
}

/**
 * Reemplaza el marcador por la estampa. Exige EXACTAMENTE una aparición: cero
 * es un fuente que ya no se puede estampar, dos es un fuente que no se entiende.
 */
export function estampar(fuenteSw, estampa) {
  const veces = vecesQueApareceElMarcador(fuenteSw);
  if (veces !== 1) {
    throw new Error(
      `public/sw.js tiene el marcador ${MARCADOR_VERSION} ${veces} veces y se esperaba exactamente 1: no se puede estampar la versión.`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(estampa)) {
    throw new Error(`La estampa "${estampa}" trae caracteres que no van en un nombre de caché.`);
  }
  return fuenteSw.replace(MARCADOR_VERSION, `const VERSION = "${estampa}";`);
}

/** El valor de VERSION que declara un sw.js (fuente o copia), o null si no se lee. */
export function leerVersion(fuenteSw) {
  const hallado = /^const VERSION = "([^"]*)";$/m.exec(fuenteSw);
  return hallado ? hallado[1] : null;
}

/** `<version>-<sha>` y, con árbol sucio, `-sucio-<AAAAMMDDhhmm>`. */
export function estampaDeVersion({ version, sha, sucio, ahora = new Date() }) {
  const base = `${version}-${sha}`;
  if (!sucio) return base;
  const fecha = ahora.toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return `${base}-sucio-${fecha}`;
}

/** Los propósitos de un icono, como los lee el navegador: lista separada por espacios, "any" si no dice. */
function propositosDe(icono) {
  const crudo =
    typeof icono.purpose === "string" && icono.purpose.trim() ? icono.purpose : "any";
  return crudo.trim().split(/\s+/);
}

/**
 * Revisa el manifiesto de un directorio `public/` (el del fuente o el del
 * bundle) y devuelve TODOS los problemas, no el primero: quien lo corre quiere
 * arreglar de una vez, no descubrir uno por despliegue.
 */
export function validarManifiesto(dirPublico) {
  const problemas = [];
  const ruta = path.join(dirPublico, "manifest.webmanifest");
  if (!existsSync(ruta)) return [`falta ${ruta}`];

  let manifiesto;
  try {
    manifiesto = JSON.parse(readFileSync(ruta, "utf8"));
  } catch (causa) {
    return [`manifest.webmanifest no es JSON válido: ${String(causa)}`];
  }
  if (!manifiesto || typeof manifiesto !== "object" || Array.isArray(manifiesto)) {
    return ["manifest.webmanifest no es un objeto JSON"];
  }

  for (const campo of [
    "name",
    "short_name",
    "start_url",
    "scope",
    "theme_color",
    "background_color",
  ]) {
    const valor = manifiesto[campo];
    if (typeof valor !== "string" || valor.trim() === "") {
      problemas.push(`manifest: falta "${campo}"`);
    }
  }
  if (manifiesto.display !== "standalone") {
    problemas.push(
      `manifest: "display" debe ser "standalone" y es ${JSON.stringify(manifiesto.display)}`,
    );
  }
  if (
    typeof manifiesto.start_url === "string" &&
    typeof manifiesto.scope === "string" &&
    !manifiesto.start_url.startsWith(manifiesto.scope)
  ) {
    problemas.push(
      `manifest: start_url ${JSON.stringify(manifiesto.start_url)} queda fuera de scope ${JSON.stringify(manifiesto.scope)}`,
    );
  }

  if (!Array.isArray(manifiesto.icons) || manifiesto.icons.length === 0) {
    problemas.push('manifest: "icons" tiene que ser una lista con al menos un icono');
    return problemas;
  }

  for (const icono of manifiesto.icons) {
    if (!icono || typeof icono.src !== "string") {
      problemas.push(`manifest: icono sin "src": ${JSON.stringify(icono)}`);
      continue;
    }
    // ERROR != VACÍO: un src que apunta a un archivo inexistente no da error en
    // ningún navegador, simplemente no se instala. Acá se abre el archivo.
    const archivo = path.join(dirPublico, icono.src.replace(/^\//, ""));
    if (!existsSync(archivo) || statSync(archivo).size === 0) {
      problemas.push(`manifest: el icono ${icono.src} no existe (o pesa 0) en ${dirPublico}`);
    }
  }

  const png = manifiesto.icons.filter(
    (i) => i && i.type === "image/png" && typeof i.src === "string",
  );
  for (const exigido of ICONOS_EXIGIDOS) {
    const hay = png.some(
      (i) => i.sizes === exigido.sizes && propositosDe(i).includes(exigido.purpose),
    );
    if (!hay) {
      problemas.push(`manifest: falta un PNG ${exigido.sizes} con purpose "${exigido.purpose}"`);
    }
  }

  return problemas;
}

/**
 * Revisa un bundle YA ARMADO (`.next/standalone` con static y public adentro).
 * Devuelve la lista de problemas; vacía = se puede subir.
 */
export function validarBundle(dirBundle) {
  const problemas = [];
  if (!existsSync(dirBundle)) {
    return [`no existe ${dirBundle}: corre \`npm run pwa:empaquetar\` primero`];
  }

  for (const relativo of ["server.js", "package.json", ".next/BUILD_ID"]) {
    if (!existsSync(path.join(dirBundle, relativo))) {
      problemas.push(`falta ${relativo} en el bundle`);
    }
  }
  if (!existsSync(path.join(dirBundle, "node_modules"))) {
    problemas.push(
      "falta node_modules en el bundle (el standalone de Next lo trae; ¿se copió a medias?)",
    );
  }

  const estaticos = path.join(dirBundle, ".next", "static");
  if (!existsSync(estaticos) || readdirSync(estaticos).length === 0) {
    problemas.push(
      "falta .next/static en el bundle (o está vacío): la app cargaría sin estilos ni JS",
    );
  }

  const publico = path.join(dirBundle, "public");
  if (!existsSync(publico)) {
    problemas.push("falta public/ en el bundle: sin manifiesto, sin worker, sin iconos");
    return problemas;
  }

  problemas.push(...validarManifiesto(publico));

  const rutaSw = path.join(publico, "sw.js");
  if (!existsSync(rutaSw)) {
    problemas.push("falta public/sw.js en el bundle");
  } else {
    const version = leerVersion(readFileSync(rutaSw, "utf8"));
    if (version === null) {
      problemas.push(
        'public/sw.js del bundle no declara `const VERSION = "...";`: no se puede saber qué versión es',
      );
    } else if (version === "v1") {
      problemas.push(
        'public/sw.js del bundle sigue con VERSION "v1": no se estampó, y este despliegue NO invalidaría los cachés del anterior',
      );
    }
  }

  const sinConexion = path.join(publico, "sin-conexion.html");
  if (!existsSync(sinConexion) || statSync(sinConexion).size === 0) {
    problemas.push(
      "falta public/sin-conexion.html (o pesa 0): sin red, el worker no tendría nada que decir",
    );
  }

  return problemas;
}

/** Suma de bytes y cantidad de archivos bajo un directorio. */
export function medir(dir) {
  let bytes = 0;
  let archivos = 0;
  if (!existsSync(dir)) return { bytes, archivos };
  const pila = [dir];
  while (pila.length > 0) {
    const actual = pila.pop();
    for (const entrada of readdirSync(actual, { withFileTypes: true })) {
      const completo = path.join(actual, entrada.name);
      if (entrada.isDirectory()) pila.push(completo);
      else if (entrada.isFile()) {
        bytes += statSync(completo).size;
        archivos += 1;
      }
    }
  }
  return { bytes, archivos };
}

export function enMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** El .md de variables se genera de las listas de arriba: una sola fuente. */
export function documentoDeVariables({ estampa, sha, fecha }) {
  const filas = (lista) => lista.map((v) => `| \`${v.nombre}\` | ${v.valor} |`).join("\n");
  return `# Variables de entorno del servidor — NutriFamilia

Bundle \`${estampa}\` (commit \`${sha}\`, empaquetado ${fecha}).

Estas son TODAS las variables que \`server.js\` necesita para correr. Se definen
en el panel del hosting (cPanel → Setup Node.js App → Environment variables) o
en el entorno del proceso; el bundle NO trae ningún \`.env\`.

## Obligatorias

| variable | valor |
|---|---|
${filas(VARIABLES_OBLIGATORIAS)}

\`NEXT_PUBLIC_*\` se hornean en el bundle del cliente al compilar (\`next build\`
las lee de \`web/.env.local\`). Si el servidor las define con OTRO proyecto, el
navegador hablaría con un Supabase y el servidor con otro. Compila y despliega
contra el mismo proyecto, siempre.

## Opcionales (asistente de IA)

| variable | valor |
|---|---|
${filas(VARIABLES_OPCIONALES)}

Sin estas, el asistente corre en modo \`fake\` (respuestas de prueba): la app
entera funciona igual, solo el asistente no habla con un modelo real.

## JAMÁS en el servidor web

| variable | por qué |
|---|---|
${VARIABLES_PROHIBIDAS.map((v) => `| \`${v.nombre}\` | ${v.porque} |`).join("\n")}

Next.js carga los \`.env*\` de la carpeta de la app DENTRO del proceso del
servidor web: cualquier secreto que se deje ahí queda al alcance de cualquier
defecto de la app. Los secretos de despliegue viven fuera, en quien despliega.
`;
}

/* ------------------------------------------------------------------ */
/* Orquestación                                                          */
/* ------------------------------------------------------------------ */

/** Corre un comando y FALLA si no termina en 0. Nada de fallas silenciosas. */
function correr(comando, args, opciones = {}) {
  const mostrado = [comando, ...args].join(" ");
  console.log(`\n$ ${mostrado}`);
  const resultado = spawnSync(comando, args, { stdio: "inherit", ...opciones });
  if (resultado.error) {
    throw new Error(`No se pudo ejecutar "${mostrado}": ${resultado.error.message}`);
  }
  if (resultado.status !== 0) {
    throw new Error(`"${mostrado}" terminó con código ${resultado.status}`);
  }
}

/** Igual que `correr` pero captura la salida, para leerla. */
function leerDe(comando, args, opciones = {}) {
  const resultado = spawnSync(comando, args, { encoding: "utf8", ...opciones });
  if (resultado.error) {
    throw new Error(`No se pudo ejecutar "${comando}": ${resultado.error.message}`);
  }
  if (resultado.status !== 0) {
    throw new Error(
      `"${[comando, ...args].join(" ")}" terminó con código ${resultado.status}: ${resultado.stderr}`,
    );
  }
  return resultado.stdout;
}

/** Sha corto y si el árbol tiene cambios. Sin git no hay procedencia, y sin procedencia no hay paquete. */
function estadoDeGit() {
  const sha = leerDe("git", ["rev-parse", "--short", "HEAD"], { cwd: RAIZ }).trim();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`git devolvió un sha raro: "${sha}"`);
  const cambios = leerDe("git", ["status", "--porcelain"], { cwd: RAIZ })
    .split(/\r?\n/)
    .filter((linea) => linea.trim() !== "");
  return { sha, sucio: cambios.length > 0, cambios: cambios.length };
}

/**
 * Las dos NEXT_PUBLIC_* tienen que existir ANTES de compilar (entorno o
 * web/.env.local). Solo se mira si están definidas: los valores no se leen ni
 * se imprimen.
 */
function comprobarVariablesDeBuild() {
  const faltan = [];
  const envLocal = path.join(WEB, ".env.local");
  const texto = existsSync(envLocal) ? readFileSync(envLocal, "utf8") : "";
  for (const nombre of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
    const enEntorno =
      typeof process.env[nombre] === "string" && process.env[nombre].trim() !== "";
    const enArchivo = new RegExp(`^\\s*${nombre}\\s*=\\s*\\S`, "m").test(texto);
    if (!enEntorno && !enArchivo) faltan.push(nombre);
  }
  if (faltan.length > 0) {
    throw new Error(
      `No se compila: faltan ${faltan.join(" y ")} (en el entorno o en web/.env.local). ` +
        "`next build` hornea esos valores en el bundle del cliente; sin ellos la app compilaría y no podría iniciar sesión.",
    );
  }
}

function rutaDeTarDeWindows() {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

function hayComando(comando, args = ["--version"]) {
  const r = spawnSync(comando, args, { encoding: "utf8" });
  return !r.error && r.status === 0 ? r.stdout : null;
}

/** Crea el zip con lo que haya en el sistema, sin agregar dependencias. */
function comprimir(dirBundle, zip) {
  const entradas = readdirSync(dirBundle);
  if (entradas.length === 0) throw new Error(`${dirBundle} está vacío: no hay qué comprimir`);
  if (existsSync(zip)) rmSync(zip);

  if (process.platform === "win32") {
    const tar = rutaDeTarDeWindows();
    if (!existsSync(tar)) {
      throw new Error(`No está ${tar} (bsdtar viene con Windows 10+). Sin él no se arma el zip.`);
    }
    correr(tar, ["-a", "-cf", zip, "-C", dirBundle, ...entradas]);
    return "tar.exe (bsdtar) de System32";
  }

  if (hayComando("zip", ["-v"])) {
    correr("zip", ["-r", "-X", "-q", zip, ...entradas], { cwd: dirBundle });
    return "zip";
  }
  const versionTar = hayComando("tar");
  if (versionTar && /bsdtar/i.test(versionTar)) {
    correr("tar", ["-a", "-cf", zip, "-C", dirBundle, ...entradas]);
    return "bsdtar";
  }
  throw new Error(
    "No hay `zip` ni bsdtar en este sistema: instala uno (apt install zip) y vuelve a correr.",
  );
}

/** Lista las entradas del zip, o null si no hay con qué listarlo (y se dice). */
function listarZip(zip) {
  const candidatos =
    process.platform === "win32"
      ? [[rutaDeTarDeWindows(), ["-tf", zip]]]
      : [
          ["unzip", ["-Z1", zip]],
          ["tar", ["-tf", zip]],
        ];
  for (const [comando, args] of candidatos) {
    const r = spawnSync(comando, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (!r.error && r.status === 0) return r.stdout.split(/\r?\n/).filter((l) => l !== "");
  }
  return null;
}

/** El zip se abre y se mira: que traiga server.js y que ninguna ruta lleve barra invertida. */
function comprobarZip(zip) {
  if (!existsSync(zip) || statSync(zip).size === 0) {
    throw new Error(`El zip no quedó escrito: ${zip}`);
  }
  const entradas = listarZip(zip);
  if (entradas === null) {
    console.warn(
      "  ! No hay con qué listar el zip en este sistema: no se pudo comprobar su contenido.",
    );
    return { entradas: null };
  }
  const normalizadas = entradas.map((e) => e.replace(/^\.\//, ""));
  if (!normalizadas.includes("server.js")) {
    throw new Error(
      `El zip no trae server.js en la raíz (${entradas.length} entradas). Primeras: ${entradas.slice(0, 5).join(", ")}`,
    );
  }
  const conBarraInvertida = entradas.filter((e) => e.includes("\\"));
  if (conBarraInvertida.length > 0) {
    throw new Error(
      `El zip trae ${conBarraInvertida.length} rutas con barra invertida (${conBarraInvertida[0]}): en Linux se descomprimirían como archivos sueltos con ese nombre.`,
    );
  }
  return { entradas: normalizadas.length };
}

function imprimirProblemas(titulo, problemas) {
  console.error(`\n${titulo}:`);
  for (const p of problemas) console.error(`  - ${p}`);
}

function imprimirTamanos() {
  const filas = [
    ["bundle completo", medir(STANDALONE)],
    [".next/static", medir(path.join(STANDALONE, ".next", "static"))],
    ["public", medir(path.join(STANDALONE, "public"))],
    ["node_modules", medir(path.join(STANDALONE, "node_modules"))],
  ];
  for (const [nombre, m] of filas) {
    console.log(`  ${nombre.padEnd(20)} ${enMB(m.bytes).padStart(9)}  (${m.archivos} archivos)`);
  }
}

function ayuda() {
  console.log(`Uso (desde web/):
  npm run pwa:empaquetar               compila, arma, valida y deja dist/nutrifamilia-pwa-<sha>.zip
  npm run pwa:empaquetar -- --limpio   antes borra web/.next y corre npm ci
  npm run pwa:validar                  valida el bundle ya armado (.next/standalone) sin compilar
`);
}

function principal(argv) {
  const banderas = new Set(argv);
  if (banderas.has("--ayuda") || banderas.has("--help") || banderas.has("-h")) {
    ayuda();
    return 0;
  }
  const soloValidar = banderas.has("--solo-validar");
  const limpio = banderas.has("--limpio");
  for (const bandera of banderas) {
    if (!["--solo-validar", "--limpio"].includes(bandera)) {
      console.error(`Bandera desconocida: ${bandera}`);
      ayuda();
      return 2;
    }
  }

  const git = estadoDeGit();
  const paquete = JSON.parse(readFileSync(path.join(WEB, "package.json"), "utf8"));
  const version = typeof paquete.version === "string" ? paquete.version : "0.0.0";
  const sufijoZip = git.sucio ? `${git.sha}-sucio` : git.sha;
  const zip = path.join(DIST, `nutrifamilia-pwa-${sufijoZip}.zip`);

  console.log(
    `NutriFamilia PWA — commit ${git.sha}${
      git.sucio ? ` (árbol SUCIO: ${git.cambios} cambios sin commit)` : " (árbol limpio)"
    }`,
  );

  if (soloValidar) {
    const problemas = validarBundle(STANDALONE);
    if (problemas.length > 0) {
      imprimirProblemas(`El bundle en ${STANDALONE} NO sirve para subir`, problemas);
      return 1;
    }
    const versionSw = leerVersion(readFileSync(path.join(STANDALONE, "public", "sw.js"), "utf8"));
    console.log(`\nBundle válido en ${STANDALONE}`);
    console.log(`  service worker VERSION = ${versionSw}`);
    imprimirTamanos();
    if (existsSync(zip)) {
      const { entradas } = comprobarZip(zip);
      console.log(
        `  zip: ${zip} (${enMB(statSync(zip).size)}${entradas === null ? "" : `, ${entradas} entradas`})`,
      );
    } else {
      console.log(
        `  ! no hay zip para este commit en dist/ (${path.basename(zip)}): corre npm run pwa:empaquetar`,
      );
    }
    return 0;
  }

  // --- compilar ---------------------------------------------------------
  if (limpio) {
    console.log("\n--limpio: se borra web/.next y se instala desde el lockfile");
    rmSync(NEXT_DIR, { recursive: true, force: true });
    correr("npm", ["ci"], { cwd: WEB, shell: process.platform === "win32" });
  }
  const binNext = path.join(WEB, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(binNext)) {
    throw new Error(
      "Falta web/node_modules (no está next): corre `npm ci` en web/ o pásame --limpio.",
    );
  }
  comprobarVariablesDeBuild();

  // Un standalone de un build anterior no se mezcla con este: se borra antes.
  rmSync(STANDALONE, { recursive: true, force: true });
  correr(process.execPath, [binNext, "build"], { cwd: WEB });
  if (!existsSync(path.join(STANDALONE, "server.js"))) {
    throw new Error(
      `next build terminó pero no dejó ${path.join(STANDALONE, "server.js")}. ¿next.config.ts sigue con output: "standalone"? ¿Next detectó otra raíz (outputFileTracingRoot)?`,
    );
  }

  // --- armar ------------------------------------------------------------
  const destinoStatic = path.join(STANDALONE, ".next", "static");
  const destinoPublic = path.join(STANDALONE, "public");
  rmSync(destinoStatic, { recursive: true, force: true });
  rmSync(destinoPublic, { recursive: true, force: true });
  cpSync(path.join(NEXT_DIR, "static"), destinoStatic, { recursive: true });
  cpSync(path.join(WEB, "public"), destinoPublic, { recursive: true });

  // --- estampar la versión del worker EN LA COPIA -----------------------
  const estampa = estampaDeVersion({ version, sha: git.sha, sucio: git.sucio });
  const rutaSwCopia = path.join(destinoPublic, "sw.js");
  writeFileSync(rutaSwCopia, estampar(readFileSync(rutaSwCopia, "utf8"), estampa), "utf8");
  if (leerVersion(readFileSync(rutaSwCopia, "utf8")) !== estampa) {
    throw new Error("Se escribió la estampa y al releer el sw.js de la copia no está: algo se cruzó.");
  }
  if (leerVersion(readFileSync(path.join(WEB, "public", "sw.js"), "utf8")) !== "v1") {
    throw new Error("El sw.js FUENTE cambió de versión: el estampado tiene que tocar solo la copia.");
  }

  // --- validar ----------------------------------------------------------
  const problemas = validarBundle(STANDALONE);
  if (problemas.length > 0) {
    imprimirProblemas(
      "El bundle quedó armado pero NO sirve para subir (no se escribe el zip)",
      problemas,
    );
    return 1;
  }

  // --- zip + variables --------------------------------------------------
  mkdirSync(DIST, { recursive: true });
  const herramienta = comprimir(STANDALONE, zip);
  const { entradas } = comprobarZip(zip);
  const fecha = new Date().toISOString();
  const rutaVariables = path.join(DIST, "VARIABLES-DE-ENTORNO.md");
  writeFileSync(rutaVariables, documentoDeVariables({ estampa, sha: git.sha, fecha }), "utf8");

  // --- resumen ----------------------------------------------------------
  console.log("\n=== Paquete listo ===");
  console.log(`  commit:              ${git.sha}${git.sucio ? " (SUCIO)" : ""}`);
  console.log(`  service worker:      VERSION = ${estampa}`);
  imprimirTamanos();
  console.log(`  zip (${herramienta}): ${zip}`);
  console.log(
    `                       ${enMB(statSync(zip).size)}${entradas === null ? "" : `, ${entradas} entradas`}`,
  );
  console.log(`  variables:           ${rutaVariables}`);
  console.log(
    "\nSube el zip, descomprímelo en la raíz de la app, define las variables del .md y arranca server.js.",
  );
  console.log("NO corras `npm run dev` ahora: borra .next/standalone.");
  return 0;
}

const invocadoDirecto =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invocadoDirecto) {
  try {
    process.exitCode = principal(process.argv.slice(2));
  } catch (causa) {
    console.error(`\nFALLÓ: ${causa instanceof Error ? causa.message : String(causa)}`);
    process.exitCode = 1;
  }
}
