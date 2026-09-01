#!/usr/bin/env node
/**
 * Saca un respaldo completo de los datos de producción.
 *
 * Hasta hoy no existía ninguno. La base tiene un hogar real con seis
 * integrantes, sus lotes de comida y sus fichas clínicas: exámenes de
 * laboratorio, condiciones y restricciones médicas. Eso no se puede volver a
 * escribir a mano si un `delete` sin `where` se lo lleva.
 *
 *   node scripts/respaldo.mjs                  respalda y ENSAYA la restauración
 *   node scripts/respaldo.mjs --sin-ensayo     respalda y no ensaya (no recomendado)
 *   node scripts/respaldo.mjs --salida D:/ruta otra carpeta de destino
 *   node scripts/respaldo.mjs --por-tabla      una consulta por tabla (ver abajo)
 *
 * Qué NO trae este respaldo, dicho acá y no en letra chica:
 *   - Los ARCHIVOS del bucket `medical-documents` (los PDF de los exámenes).
 *     Este canal saca filas de la base, no binarios de Storage. El respaldo
 *     inventaría cuáles hay y declara que faltan; no los cuenta como cero.
 *   - `auth.users` completa. Se guardan id, correo y fecha de creación, y NADA
 *     de credenciales. Ver `COLUMNAS_AUTH_USERS` en respaldo-lib.mjs.
 *   - El ESQUEMA. La fuente de verdad del esquema son las migraciones del
 *     repo; el respaldo guarda el hash de cada una para saber contra cuál
 *     esquema se sacó.
 *
 * El token de la Management API sale de `.env.deploy` y NO se imprime nunca.
 */

import { mkdirSync, existsSync, writeFileSync, renameSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  SALTO,
  SQL_ESQUEMA,
  TABLA_AUTH_USERS,
  armarArchivoDeRespaldo,
  credenciales,
  dirRespaldosPorDefecto,
  ejecutorSupabase,
  exigirArreglo,
  migracionesDelRepo,
  morir,
  motivoParaNoGuardarAca,
  redactar,
  sqlFotoCompleta,
  sqlTablaSuelta,
} from "./respaldo-lib.mjs";

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const tieneBandera = (nombre) => args.includes(nombre);
function valorDe(nombre) {
  const i = args.indexOf(nombre);
  return i >= 0 ? args[i + 1] ?? null : null;
}

const ENSAYAR = !tieneBandera("--sin-ensayo");
const POR_TABLA = tieneBandera("--por-tabla");
const DESTINO = path.resolve(valorDe("--salida") ?? dirRespaldosPorDefecto());

const noGuardarAca = motivoParaNoGuardarAca(DESTINO);
if (noGuardarAca) morir(noGuardarAca);

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

/**
 * La foto completa y la tabla suelta viven en `respaldo-lib.mjs`.
 *
 * El precio de la foto en una sola consulta es que la respuesta entera tiene
 * que caber en una respuesta HTTP. Hoy la base son ~1.100 filas y sobra
 * muchísimo; si algún día no cabe, la consulta falla FUERTE y queda
 * `--por-tabla`, que sí funciona pero pierde la coherencia entre tablas y lo
 * deja escrito en la cabecera del archivo.
 */

/**
 * Inventario del bucket clínico.
 *
 * Va aparte y con su propio try/catch porque el esquema `storage` puede no
 * estar o no dejarse leer. Si no se puede mirar, el respaldo dice DESCONOCIDO
 * — jamás cero. Un inventario vacío y un inventario que no se pudo leer son
 * cosas distintas, y confundirlas acá significaría creer que no hay exámenes
 * que rescatar cuando en realidad no se sabe.
 */
const SQL_STORAGE = `
select jsonb_build_object(
  'buckets', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', b.id, 'nombre', b.name, 'publico', b.public) order by b.id), '[]'::jsonb)
              from storage.buckets b),
  'objetos', (select coalesce(jsonb_agg(jsonb_build_object(
                'bucket', o.bucket_id,
                'nombre', o.name,
                'tamano_bytes', (o.metadata->>'size'),
                'actualizado', to_char(o.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
              ) order by o.bucket_id, o.name), '[]'::jsonb)
              from storage.objects o)
) as inventario
`;

// ---------------------------------------------------------------------------
// Corrida
// ---------------------------------------------------------------------------

let creds;
try {
  creds = credenciales();
} catch (e) {
  morir(e instanceof Error ? e.message : String(e));
}
const supa = ejecutorSupabase(creds);

console.log(`Respaldo de ${supa.nombre}`);
console.log(`  Destino: ${DESTINO}`);
console.log("");

// --- 1. Esquema -------------------------------------------------------------

let esquema;
try {
  const filas = await supa.ejecutar(SQL_ESQUEMA);
  esquema = filas[0].esquema;
} catch (e) {
  morir(`No se pudo leer el esquema de producción: ${e instanceof Error ? e.message : String(e)}`);
}

const tablasPublic = esquema.tablas.map((t) => ({ ...t, esquema: "public" }));

// Las columnas de identidad (`generated always as identity`) necesitarían
// `overriding system value` al reinsertar y hoy no existe ninguna. Si mañana
// aparece una, el respaldo se planta acá en vez de generar un archivo que no
// se puede volver a meter — que es la clase de sorpresa que se descubre justo
// la noche que hay que restaurar.
const conIdentidad = tablasPublic.flatMap((t) =>
  t.columnas.filter((c) => c.identidad).map((c) => `${t.nombre}.${c.nombre}`),
);
if (conIdentidad.length > 0) {
  morir(
    [
      "Hay columnas `identity` que este respaldo no sabe reinsertar:",
      ...conIdentidad.map((c) => `  - ${c}`),
      "Hay que enseñarle `overriding system value` antes de confiar en el archivo.",
    ].join(SALTO),
  );
}

const sinPk = tablasPublic.filter((t) => t.pk.length === 0).map((t) => t.nombre);
const derivadas = tablasPublic.flatMap((t) =>
  t.columnas.filter((c) => c.derivada).map((c) => `${t.nombre}.${c.nombre}`),
);

const tablas = [...tablasPublic, TABLA_AUTH_USERS];
console.log(`Esquema leído: ${tablasPublic.length} tablas en public + auth.users (parcial).`);
if (derivadas.length > 0) {
  console.log(`  Columnas derivadas (las recalcula la base, no se guardan): ${derivadas.join(", ")}`);
}
if (sinPk.length > 0) {
  console.log(`  Sin llave primaria (se ordenan por todas sus columnas): ${sinPk.join(", ")}`);
}

// --- 2. Datos ---------------------------------------------------------------

const inicio = Date.now();
const datos = {};
let coherente = true;

if (POR_TABLA) {
  coherente = false;
  console.log("");
  console.log("MODO --por-tabla: una consulta por tabla.");
  console.log("  Cada tabla se lee en un momento distinto: el respaldo NO es una foto");
  console.log("  coherente del conjunto. Queda anotado en la cabecera del archivo.");
  for (const t of tablas) {
    try {
      const filas = await supa.ejecutar(sqlTablaSuelta(t));
      datos[t.nombre] = filas[0].filas;
    } catch (e) {
      morir(`Falló la tabla ${t.nombre}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
} else {
  try {
    const filas = await supa.ejecutar(sqlFotoCompleta(tablas));
    const crudo = filas[0]?.datos;
    if (!crudo) morir("La consulta de respaldo no devolvió datos. No se escribe nada.");
    Object.assign(datos, crudo);
  } catch (e) {
    morir(
      [
        `Falló la consulta única de respaldo: ${e instanceof Error ? e.message : String(e)}`,
        "",
        "Si el motivo es el tamaño de la respuesta, la base creció más allá de lo que",
        "cabe en una sola llamada. Corre `node scripts/respaldo.mjs --por-tabla`, que",
        "funciona pero deja de ser una foto coherente entre tablas (y lo declara).",
      ].join(SALTO),
    );
  }
}

// Toda tabla del esquema tiene que haber traído su arreglo. Una clave ausente
// sería una tabla saltada en silencio: ERROR != VACÍO.
for (const t of tablas) {
  if (!Array.isArray(datos[t.nombre])) {
    morir(
      `La tabla ${t.nombre} no vino en la respuesta (llegó ${JSON.stringify(datos[t.nombre])}). ` +
        "No se escribe un respaldo al que le falta una tabla.",
    );
  }
}

// --- 3. Inventario de Storage ----------------------------------------------

let inventario;
try {
  const filas = await supa.ejecutar(SQL_STORAGE);
  inventario = {
    estado: "LEIDO",
    ...filas[0].inventario,
    binarios_incluidos: false,
    nota: "Este respaldo guarda la FILA de lab_documents, no el PDF del examen.",
  };
} catch (e) {
  inventario = {
    estado: "DESCONOCIDO",
    motivo: redactar(e instanceof Error ? e.message : String(e)),
    binarios_incluidos: false,
    nota: "No se pudo leer el inventario del bucket. DESCONOCIDO no es cero: puede haber archivos.",
  };
}

// --- 4. Escritura -----------------------------------------------------------

mkdirSync(DESTINO, { recursive: true, mode: 0o700 });

const marca = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
const nombreArchivo = `mesa-familiar-${creds.ref}-${marca}.ndjson`;
const rutaFinal = path.join(DESTINO, nombreArchivo);
// Se escribe con otro nombre y se renombra al final. Mientras el respaldo no
// esté cerrado NO tiene el nombre de un respaldo: si el proceso muere ahora,
// lo que queda en el disco se llama `.parcial` y nadie lo confunde con algo
// que sirva.
const rutaParcial = `${rutaFinal}.parcial`;

const migraciones = migracionesDelRepo();

// El armado del NDJSON vive en respaldo-lib.mjs: es la MISMA función que usa la
// prueba del camino real para fabricar su respaldo. Si el generador y el que se
// prueba no son el mismo código, el round-trip no prueba el generador.
const { texto, cierre, resumenClinico } = armarArchivoDeRespaldo({
  tablas,
  datos,
  esquema,
  migraciones,
  proyectoRef: creds.ref,
  inventario,
  coherente,
  duracionMs: Date.now() - inicio,
});

try {
  writeFileSync(rutaParcial, texto, { encoding: "utf8", mode: 0o600 });
  renameSync(rutaParcial, rutaFinal);
} catch (e) {
  try {
    if (existsSync(rutaParcial)) rmSync(rutaParcial, { force: true });
  } catch {
    /* si no se puede borrar el parcial, igual el nombre dice que no sirve */
  }
  morir(`No se pudo escribir el respaldo: ${e instanceof Error ? e.message : String(e)}`);
}

const tamano = statSync(rutaFinal).size;

console.log("");
console.log(`Respaldo escrito: ${rutaFinal}`);
console.log(`  ${cierre.tablas} tablas · ${cierre.filas} filas · ${(tamano / 1024).toFixed(1)} KiB`);
console.log(`  SHA-256 del contenido: ${cierre.sha256_contenido}`);
console.log(`  Foto coherente entre tablas: ${coherente ? "sí (una sola transacción)" : "NO (--por-tabla)"}`);

if (resumenClinico.length > 0) {
  console.log("");
  console.log("Este archivo tiene DATOS CLÍNICOS de personas reales:");
  for (const linea of resumenClinico) console.log(`  - ${linea} fila(s)`);
  console.log("  No lo subas a ninguna nube, no lo adjuntes a un correo, no lo metas al repo.");
  console.log("  Detalle en docs/deployment/respaldo-y-restauracion.md");
}

if (inventario.estado === "LEIDO") {
  // `?? []` acá imprimiría «Archivos en Storage: 0» cuando lo cierto es que el
  // inventario dice haberse leído y no trae la lista. Cero archivos y «no sé
  // cuántos» son cosas distintas, y ésta es justo la línea con la que alguien
  // decide si tiene que ir a bajar exámenes en PDF a mano.
  let objetos;
  try {
    objetos = exigirArreglo(
      inventario.objetos,
      "la lista de objetos que dice haber leído",
      "El inventario de Storage",
    );
  } catch (e) {
    // El archivo ya está escrito y sus datos están bien; lo que no se puede
    // decir es cuántos exámenes hay que bajar aparte. Se muere igual: el
    // restaurador se planta en el mismo punto, así que anunciar un respaldo
    // bueno sería anunciar algo que después no se va a poder restaurar.
    morir(e instanceof Error ? e.message : String(e));
  }
  console.log("");
  console.log(`Archivos en Storage: ${objetos.length} (los binarios NO están en este respaldo).`);
} else {
  console.log("");
  console.log("Inventario de Storage: DESCONOCIDO (no se pudo leer). No es cero: puede haber archivos.");
  console.log(`  Motivo: ${inventario.motivo}`);
}

// --- 5. Ensayo de restauración ---------------------------------------------

if (!ENSAYAR) {
  console.log("");
  console.log("NO se ensayó la restauración (--sin-ensayo).");
  console.log("Un respaldo que nadie probó restaurar todavía no es un respaldo. Corre:");
  console.log(`  node scripts/respaldo-restaurar.mjs "${rutaFinal}"`);
  process.exit(0);
}

console.log("");
console.log("Ensayando la restauración contra un Postgres limpio…");
const ensayo = spawnSync(
  process.execPath,
  [path.join(import.meta.dirname, "respaldo-restaurar.mjs"), rutaFinal],
  { stdio: "inherit" },
);

if (ensayo.status !== 0) {
  morir(
    [
      "EL RESPALDO SE ESCRIBIÓ PERO NO SE PUDO RESTAURAR.",
      `  Archivo: ${rutaFinal}`,
      "No lo trates como un respaldo válido hasta entender por qué falló el ensayo.",
    ].join(SALTO),
  );
}
