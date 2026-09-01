/**
 * Piezas compartidas entre `respaldo.mjs` (sacar) y `respaldo-restaurar.mjs`
 * (devolver y comprobar).
 *
 * El respaldo y la restauración tienen que hablar EXACTAMENTE el mismo idioma:
 * las mismas expresiones de lectura, el mismo orden de filas y la misma forma
 * canónica al calcular el hash. Si el que saca y el que devuelve serializan
 * distinto, la verificación compara peras con manzanas y da un verde que no
 * significa nada. Por eso viven acá y no duplicadas en cada script.
 *
 * NO imprime NUNCA el token de la Management API. `redactar()` lo saca de
 * cualquier texto antes de que llegue a la consola.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SALTO = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const COMILLAS = new RegExp("^[\"']|[\"']$", "g");

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIR_MIGRACIONES = path.join(RAIZ, "supabase", "migrations");
export const LIBRO_PRODUCCION = path.join(RAIZ, "supabase", "estado-produccion.json");
const ENV_DESPLIEGUE = path.join(RAIZ, ".env.deploy");
const ENV_LOCAL = path.join(RAIZ, "web", ".env.local");

/** Cambia sólo si cambia la forma del archivo. El restaurador lo exige. */
export const VERSION_FORMATO = 1;

/**
 * Tablas con datos clínicos de personas reales. No cambian el algoritmo: se
 * nombran para que cada corrida diga en voz alta qué está sacando del hogar y
 * cuántas filas de eso hay. Un respaldo médico que se genera en silencio se
 * termina guardando en cualquier parte.
 */
export const TABLAS_CLINICAS = [
  "lab_documents",
  "lab_observations",
  "lab_extraction_candidates",
  "member_conditions",
  "member_clinical_restrictions",
  "member_lab_schedules",
  "meal_clinical_assessments",
  "clinical_impact_reviews",
  "medical_data_grants",
];

// ---------------------------------------------------------------------------
// Dónde puede vivir un archivo con la ficha médica de una familia
// ---------------------------------------------------------------------------

/**
 * Carpeta por defecto: FUERA del repo, en el perfil del usuario.
 *
 * Adentro del repo el archivo termina en un `git add .` cualquier día — y ese
 * `git push` publica exámenes de laboratorio de seis personas reales en un
 * remoto del que ya no se borran (quedan en la historia y en cada clon). El
 * respaldo no se guarda donde vive el código.
 */
export function dirRespaldosPorDefecto() {
  const casa = process.env.USERPROFILE ?? process.env.HOME ?? RAIZ;
  return path.join(casa, "respaldos-mesa-familiar");
}

/**
 * Carpetas que sincronizan solas contra la nube de un tercero.
 *
 * Guardar el respaldo en una de éstas no es "guardarlo en el computador": es
 * subirlo, sin quererlo, a un servidor que no es nuestro y que no firmó nada
 * sobre datos de salud. En Windows además pasa sin avisar, porque OneDrive
 * redirige «Documentos» y «Escritorio» de fábrica.
 */
const CARPETAS_QUE_SUBEN = [
  "onedrive",
  "dropbox",
  "google drive",
  "googledrive",
  "grive",
  "icloud",
  "box sync",
  "mega",
  "pcloud",
  "yandexdisk",
  "sync.com",
];

/**
 * Se planta si el destino elegido publica el archivo en alguna parte.
 *
 * Devuelve el motivo (texto) o `null` si el lugar sirve. No hay bandera para
 * saltárselo: si el lugar está mal, el arreglo es elegir otro lugar.
 */
export function motivoParaNoGuardarAca(destino) {
  const abs = path.resolve(destino);
  const dentroDelRepo = abs === RAIZ || abs.startsWith(RAIZ + path.sep);
  if (dentroDelRepo) {
    return [
      `${abs} está DENTRO del repositorio.`,
      "Un respaldo con exámenes de laboratorio de una familia real no se guarda junto al código:",
      "basta un `git add .` para publicarlo, y de la historia de git ya no sale.",
      `Usa la carpeta por defecto (${dirRespaldosPorDefecto()}) o pasa --salida con otra ruta.`,
    ].join(SALTO);
  }
  const enMinusculas = abs.toLowerCase();
  const nube = CARPETAS_QUE_SUBEN.find((c) => enMinusculas.includes(c));
  if (nube) {
    return [
      `${abs} parece una carpeta que sincroniza sola con la nube («${nube}»).`,
      "Eso no es guardar el respaldo: es subirlo a un servidor de un tercero que nunca",
      "acordó nada sobre datos de salud. En Windows pasa sin avisar, porque OneDrive",
      "redirige «Documentos» y «Escritorio» de fábrica.",
      "Elige una carpeta local que NO se sincronice, o un disco externo.",
    ].join(SALTO);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Credenciales
// ---------------------------------------------------------------------------

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

let TOKEN_EN_MEMORIA = null;

/**
 * Token de la Management API + ref del proyecto.
 *
 * El token vive en `.env.deploy` (ignorado por git) y NO en `web/.env.local`,
 * por lo mismo que explica `aplicar-migracion.mjs`: Next.js carga ese archivo
 * dentro del proceso del servidor web y este token corre SQL arbitrario sobre
 * toda la cuenta, incluida la base clínica.
 */
export function credenciales() {
  const token =
    process.env.SUPABASE_ACCESS_TOKEN ?? delArchivo(ENV_DESPLIEGUE, "SUPABASE_ACCESS_TOKEN");
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    delArchivo(ENV_DESPLIEGUE, "NEXT_PUBLIC_SUPABASE_URL") ??
    delArchivo(ENV_LOCAL, "NEXT_PUBLIC_SUPABASE_URL") ??
    "";
  const ref = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? null;

  if (!token) {
    throw new Error(
      [
        "Falta SUPABASE_ACCESS_TOKEN.",
        "  Vive en .env.deploy en la raíz del repo (ignorado por git):",
        "      SUPABASE_ACCESS_TOKEN=sbp_...",
        "  Se crea y se revoca en https://supabase.com/dashboard/account/tokens",
      ].join(SALTO),
    );
  }
  if (!ref) {
    throw new Error("No se pudo deducir el ref del proyecto desde NEXT_PUBLIC_SUPABASE_URL.");
  }
  TOKEN_EN_MEMORIA = token;
  return { token, ref };
}

/**
 * Saca el token de cualquier texto antes de imprimirlo.
 *
 * Un mensaje de error se copia y se pega en un chat sin pensarlo dos veces. Si
 * alguna vez una traza arrastra el token, el que lo lee ya tiene la llave de
 * toda la cuenta. Cuesta tres líneas evitarlo.
 */
export function redactar(texto) {
  let salida = String(texto);
  if (TOKEN_EN_MEMORIA) salida = salida.split(TOKEN_EN_MEMORIA).join("sbp_<oculto>");
  return salida.replace(/sbp_[A-Za-z0-9]{8,}/g, "sbp_<oculto>");
}

/**
 * Corta la corrida con un código de salida, SIN `process.exit()`.
 *
 * `process.exit()` con un socket de `fetch` todavía abierto revienta en Windows
 * con «Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)» y el proceso
 * muere con 127 en vez del código pedido. Acá eso hacía dos cosas graves: el
 * mensaje «EL RESPALDO SE ESCRIBIÓ PERO NO SE PUDO RESTAURAR» salía seguido de
 * un volcado de libuv, y el camino de ÉXITO de `respaldo.mjs --sin-ensayo`
 * devolvía 127 — un respaldo bueno reportado como falla, justo contra la
 * promesa del runbook («termina con código distinto de cero cuando algo sale
 * mal»). Es el mismo bug ya documentado en `aplicar-migracion.mjs` y
 * `verificar-estado-produccion.mjs`.
 *
 * Por eso `morir()` LANZA en vez de salir: cada punto de entrada atrapa
 * `SalidaLimpia` al final y la convierte en `process.exitCode`, y Node cierra
 * sus sockets solo antes de terminar con el código correcto.
 */
export class SalidaLimpia extends Error {
  constructor(codigo) {
    super(`salida ${codigo}`);
    this.name = "SalidaLimpia";
    this.codigo = codigo;
  }
}

export function morir(mensaje, codigo = 1) {
  console.error("");
  console.error(redactar(mensaje));
  console.error("");
  throw new SalidaLimpia(codigo);
}

/**
 * Exige que un dato del respaldo EXISTA, en vez de rellenarlo con `?? []`.
 *
 * Nació de un hallazgo concreto: `cabecera.esquema.fks ?? []` hacía que un
 * archivo SIN el bloque de llaves foráneas imprimiera «Llaves foráneas
 * comprobadas: 0 · huérfanos: 0» y cerrara con «RESTAURACIÓN OK … sin
 * huérfanos». Ausencia total de comprobación anunciada como comprobación
 * limpia, en el archivo que decide si se confía o no en el respaldo. Hoy no
 * hay forma de generar un archivo así, pero el que decide la confianza no
 * puede tener un camino donde «no sé» se lea igual que «está limpio».
 */
export function exigirArreglo(valor, queEs, deDonde) {
  if (!Array.isArray(valor)) {
    throw new Error(
      [
        `${deDonde} no trae ${queEs} (llegó ${valor === undefined ? "nada" : JSON.stringify(valor).slice(0, 60)}).`,
        "Sin ese bloque no se puede comprobar nada de eso, y NO se va a dar por bueno",
        "lo que no se miró. El archivo no sirve para restaurar: saca un respaldo nuevo.",
      ].join(SALTO),
    );
  }
  return valor;
}

// ---------------------------------------------------------------------------
// Ejecutores de SQL (misma interfaz, dos destinos)
// ---------------------------------------------------------------------------

/**
 * Producción, por la Management API.
 *
 * Cada llamada HTTP es su propia transacción: NO hay forma de mantener una
 * transacción abierta entre dos llamadas. De ahí sale la decisión del respaldo
 * de sacar todas las tablas en UNA sola consulta (ver `respaldo.mjs`).
 */
export function ejecutorSupabase({ token, ref }) {
  const ejecutor = {
    nombre: `Supabase ${ref}`,
    /** Escribe de verdad. Existe separada de `ejecutar` para que el modo en
     *  seco pueda interceptar SÓLO las escrituras y dejar pasar las lecturas. */
    async escribir(sql) {
      return ejecutor.ejecutar(sql);
    },
    async ejecutar(sql) {
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
      // Si la respuesta llega cortada, JSON.parse revienta acá y el respaldo se
      // cae ANTES de escribir nada. Un archivo a medias es peor que ninguno.
      try {
        return JSON.parse(texto);
      } catch (e) {
        throw new Error(
          `La respuesta de Supabase no es JSON válido (¿llegó cortada? ${texto.length} bytes): ${e}`,
        );
      }
    },
  };
  return ejecutor;
}

/** Postgres real en WASM, para el ensayo de restauración. */
export function ejecutorPglite(db, nombre = "PGlite (Postgres en WASM)") {
  const ejecutor = {
    nombre,
    async escribir(sql) {
      return ejecutor.ejecutar(sql);
    },
    async ejecutar(sql) {
      const r = await db.exec(sql);
      // `exec` acepta varias sentencias; interesa el resultado de la última que
      // devolvió filas, que es como se comporta la Management API.
      for (let i = r.length - 1; i >= 0; i -= 1) {
        if (r[i].rows.length > 0) return r[i].rows;
      }
      return [];
    },
  };
  return ejecutor;
}

/**
 * El preámbulo que lleva CADA sentencia de carga.
 *
 * `session_replication_role = replica` apaga los disparadores de integridad
 * referencial. Sin eso no hay orden de inserción posible: el esquema tiene un
 * ciclo real (`meal_templates` ↔ `meal_template_versions`).
 */
export const PREAMBULO_CARGA =
  "set search_path to public, pg_catalog; set session_replication_role = replica;";

/**
 * Sonda del permiso, para correr ANTES de borrar nada.
 *
 * `set session_replication_role` es un parámetro de contexto SUPERUSUARIO. La
 * Management API de Supabase corre como `postgres`, que NO es superusuario, así
 * que el permiso hay que preguntarlo, no suponerlo. PGlite sí corre como
 * superusuario: el ensayo da verde ahí POR CONSTRUCCIÓN y no puede detectar
 * este problema. Por eso la sonda existe y por eso corre contra el destino de
 * verdad.
 *
 * No escribe una sola fila: sube el parámetro, lo lee de vuelta y lo devuelve a
 * `origin`. Lo lee de vuelta a propósito — un SET que no toma efecto y no falla
 * sería el peor de los dos casos: la carga entraría con las llaves foráneas
 * VIVAS y reventaría a mitad, con la base ya borrada.
 */
export const SQL_SONDA_REPLICACION = `
  ${PREAMBULO_CARGA}
  select current_user::text as rol,
         current_setting('is_superuser') as superusuario,
         current_setting('session_replication_role') as replicacion;
`;

/** Interpreta la respuesta de `SQL_SONDA_REPLICACION`. Pura, para poder probarla. */
export function interpretarSonda(filas) {
  if (!Array.isArray(filas) || filas.length === 0) {
    return { permitido: false, motivo: "la sonda no devolvió ninguna fila", detalle: null };
  }
  const f = filas[0];
  const valor = f.replicacion ?? null;
  if (valor === null) {
    return { permitido: false, motivo: "la sonda no devolvió session_replication_role", detalle: f };
  }
  if (String(valor) !== "replica") {
    return {
      permitido: false,
      motivo: `el SET no tomó efecto: session_replication_role quedó en «${valor}»`,
      detalle: f,
    };
  }
  return { permitido: true, motivo: null, detalle: f };
}

// ---------------------------------------------------------------------------
// PGlite: base limpia con las migraciones del repo
// ---------------------------------------------------------------------------

/**
 * Lo que Supabase trae de fábrica y las migraciones dan por hecho.
 *
 * Es el mismo preámbulo de `web/src/integration/harness.ts`, con `created_at`
 * agregado en `auth.users`: el respaldo guarda esa columna para poder reponer
 * la identidad de cada integrante, y sin ella el INSERT del ensayo fallaría.
 */
const ENTORNO_SUPABASE = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text, created_at timestamptz);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public
    grant select, insert, update, delete on tables to authenticated;
`;

/** Migraciones del repo, en orden de número. El número es el contrato. */
export function migracionesDelRepo() {
  return readdirSync(DIR_MIGRACIONES)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((archivo) => {
      const bytes = readFileSync(path.join(DIR_MIGRACIONES, archivo));
      return { archivo, sha256: createHash("sha256").update(bytes).digest("hex"), sql: bytes.toString("utf8") };
    });
}

/**
 * Diferencias de FORMA entre un esquema leído del catálogo y el que declara un
 * respaldo: tablas que faltan o sobran, columnas que faltan o sobran, y —para
 * las que están en los dos lados— tipo, obligatoriedad y presencia de valor por
 * defecto. Las columnas derivadas no cuentan (el respaldo no las guarda porque
 * la base las recalcula sola).
 *
 * `obligatoria` y `con_default` entraron a la comparación porque el respaldo ya
 * los guardaba y el chequeo de bloqueos del restaurador ya los usaba: mirarlos
 * en un lado y no en el otro era mirar menos de lo que se sabe.
 *
 * LO QUE ESTA FUNCIÓN NO MIRA, y hay que tenerlo presente antes de llamar
 * «idéntico» a un esquema: restricciones CHECK, llaves foráneas, disparadores,
 * funciones, políticas de RLS e índices. Dos migraciones que sólo cambian
 * políticas se ven EXACTAMENTE iguales acá. Por eso `baseDePruebas` no elige el
 * nivel del respaldo sólo con esto.
 */
export function diferenciasDeEsquema(tablasDestino, tablasRespaldo) {
  const esperado = new Map(
    tablasRespaldo
      .filter((t) => (t.esquema ?? "public") === "public")
      .map((t) => [t.nombre, new Map(t.columnas.map((c) => [c.nombre, c]))]),
  );
  const actual = new Map(
    tablasDestino.map((t) => [
      t.nombre,
      new Map(t.columnas.filter((c) => !c.derivada).map((c) => [c.nombre, c])),
    ]),
  );

  const diferencias = [];
  for (const [tabla, columnas] of esperado) {
    const enDestino = actual.get(tabla);
    if (!enDestino) {
      diferencias.push({ clase: "tabla_faltante", tabla, detalle: `falta la tabla ${tabla}` });
      continue;
    }
    for (const [col, esperada] of columnas) {
      const d = enDestino.get(col);
      if (d === undefined) {
        diferencias.push({ clase: "columna_faltante", tabla, columna: col, detalle: `${tabla}.${col} no existe en el destino` });
        continue;
      }
      if (d.tipo !== esperada.tipo) {
        diferencias.push({
          clase: "tipo_distinto",
          tabla,
          columna: col,
          detalle: `${tabla}.${col} es ${esperada.tipo} en el respaldo y ${d.tipo} en el destino`,
        });
      }
      // Los flags sólo se comparan cuando los DOS lados los declaran: un
      // respaldo viejo puede no traerlos, y ahí la respuesta honesta es «no se
      // sabe», no «son distintos».
      if (typeof esperada.obligatoria === "boolean" && typeof d.obligatoria === "boolean" && esperada.obligatoria !== d.obligatoria) {
        diferencias.push({
          clase: "obligatoriedad_distinta",
          tabla,
          columna: col,
          detalle: `${tabla}.${col} es ${esperada.obligatoria ? "obligatoria" : "opcional"} en el respaldo y ${d.obligatoria ? "obligatoria" : "opcional"} en el destino`,
        });
      }
      if (typeof esperada.con_default === "boolean" && typeof d.con_default === "boolean" && esperada.con_default !== d.con_default) {
        diferencias.push({
          clase: "default_distinto",
          tabla,
          columna: col,
          detalle: `${tabla}.${col} ${esperada.con_default ? "tenía" : "no tenía"} valor por defecto en el respaldo y ${d.con_default ? "lo tiene" : "no lo tiene"} en el destino`,
        });
      }
    }
    for (const col of enDestino.keys()) {
      if (!columnas.has(col)) {
        diferencias.push({ clase: "columna_extra", tabla, columna: col, detalle: `${tabla}.${col} sobra en el destino` });
      }
    }
  }
  for (const tabla of actual.keys()) {
    if (!esperado.has(tabla)) {
      diferencias.push({ clase: "tabla_extra", tabla, detalle: `${tabla} sobra en el destino` });
    }
  }
  return diferencias;
}

// ---------------------------------------------------------------------------
// El libro de estado de producción
// ---------------------------------------------------------------------------

/**
 * Qué migraciones tiene puestas producción, según `supabase/estado-produccion.json`.
 *
 * El respaldo no puede deducir eso mirando columnas: 0033, 0034 y 0035 dejan el
 * catálogo de columnas EXACTAMENTE igual (una toca disparadores, otra políticas
 * de storage y otra un CHECK), así que tres niveles distintos «calzan» con el
 * mismo respaldo. Elegir uno al azar y llamarlo exacto es inventar. El libro sí
 * lo sabe, porque se llena preguntándole a la base real por un testigo.
 *
 * Se lee a la defensiva y NUNCA se muere acá: si el libro no está, no calza con
 * el proyecto del respaldo o está caducado, se devuelve `usable: false` con el
 * motivo, y quien llama declara la ambigüedad en vez de taparla.
 */
export function libroDeProduccion({ refEsperado = null, hoy = new Date() } = {}) {
  let crudo;
  try {
    crudo = JSON.parse(readFileSync(LIBRO_PRODUCCION, "utf8"));
  } catch (e) {
    return { usable: false, motivo: `no se pudo leer supabase/estado-produccion.json (${e})`, aplicadas: null };
  }
  const migraciones = crudo?.migraciones;
  if (migraciones === null || typeof migraciones !== "object") {
    return { usable: false, motivo: "el libro no trae el bloque `migraciones`", aplicadas: null };
  }
  if (refEsperado !== null && crudo.proyecto !== refEsperado) {
    return {
      usable: false,
      motivo: `el libro habla del proyecto ${crudo.proyecto} y el respaldo salió de ${refEsperado}`,
      aplicadas: null,
    };
  }
  if (typeof crudo.caduca_el === "string" && crudo.caduca_el < hoy.toISOString().slice(0, 10)) {
    return {
      usable: false,
      motivo: `el libro caducó el ${crudo.caduca_el}: corre node scripts/verificar-estado-produccion.mjs`,
      aplicadas: null,
    };
  }

  const aplicadas = new Set();
  const shas = new Map();
  for (const [archivo, dato] of Object.entries(migraciones)) {
    if (dato?.estado === "APLICADA") aplicadas.add(archivo);
    if (typeof dato?.sha256 === "string") shas.set(archivo, dato.sha256);
  }
  return { usable: true, motivo: null, aplicadas, shas, verificado_el: crudo.verificado_el ?? null };
}

function cargarPglite() {
  try {
    const req = createRequire(path.join(RAIZ, "web", "package.json"));
    return {
      PGlite: req("@electric-sql/pglite").PGlite,
      pg_trgm: req("@electric-sql/pglite/contrib/pg_trgm").pg_trgm,
      pgcrypto: req("@electric-sql/pglite/contrib/pgcrypto").pgcrypto,
    };
  } catch (e) {
    throw new Error(
      `No se pudo cargar PGlite desde web/node_modules. Corre \`npm install\` en web/. (${e})`,
    );
  }
}

async function baseVacia() {
  const { PGlite, pg_trgm, pgcrypto } = cargarPglite();
  const db = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
  await db.exec("create extension if not exists pg_trgm; create extension if not exists pgcrypto;");
  await db.exec(ENTORNO_SUPABASE);
  return db;
}

async function esquemaDe(db) {
  const resultado = await db.exec(SQL_ESQUEMA);
  return resultado[resultado.length - 1].rows[0].esquema;
}

/**
 * Postgres desechable con EXACTAMENTE las migraciones que se le pidan.
 *
 * `baseDePruebas` decide sola el nivel mirando el respaldo y el libro de
 * producción, que es lo correcto para un ensayo pero inservible para una prueba
 * automatizada: el nivel cambiaría con el libro y el test dejaría de ser
 * determinista. Acá la cadena la dicta quien llama, y devuelve la misma forma
 * que `baseDePruebas` para que el motor no note la diferencia.
 *
 * Los archivos se nombran igual que en `supabase/migrations/` (con o sin ruta).
 * Uno que no exista revienta con nombre y apellido: una prueba de respaldos que
 * se salta una migración en silencio es la clase de verde que no significa nada.
 */
export async function baseConMigraciones(archivos) {
  const todas = migracionesDelRepo();
  const porArchivo = new Map(todas.map((m) => [m.archivo, m]));
  const pedidas = archivos.map((a) => {
    const base = path.basename(a);
    const m = porArchivo.get(base);
    if (!m) throw new Error(`No existe supabase/migrations/${base}`);
    return m;
  });

  const db = await baseVacia();
  for (const m of pedidas) {
    try {
      await db.exec(m.sql);
    } catch (e) {
      await db.close();
      throw new Error(`La migración ${m.archivo} no aplica en PGlite: ${e}`);
    }
  }
  const enCadena = new Set(pedidas.map((m) => m.archivo));
  return {
    db,
    aplicadas: pedidas,
    todas,
    sobrantes: todas.filter((m) => !enCadena.has(m.archivo)).map((m) => m.archivo),
    nivel: pedidas.length > 0 ? pedidas[pedidas.length - 1].archivo : null,
    fuente: "cadena-pedida",
    calces: [],
    notas: [],
  };
}

/** Aplica una lista de migraciones sobre una base y devuelve su esquema. */
async function esquemaTras(archivos, todas) {
  const db = await baseVacia();
  try {
    const porArchivo = new Map(todas.map((m) => [m.archivo, m]));
    for (const archivo of archivos) await db.exec(porArchivo.get(archivo).sql);
    return (await esquemaDe(db)).tablas;
  } finally {
    await db.close();
  }
}

/**
 * Elige QUÉ migraciones tenía puestas la base cuando se sacó el respaldo.
 *
 * Función aparte y sin base de datos adentro (recibe el esquema ya medido) para
 * poder probarla sin levantar cuarenta migraciones. Devuelve la selección, de
 * dónde salió, y las notas que hay que decir en voz alta.
 *
 * Hay dos fuentes y NO valen lo mismo:
 *
 *   1. El libro `supabase/estado-produccion.json`, que se llena preguntándole a
 *      la base REAL por un testigo por migración. Es la única que sabe la
 *      verdad, y además puede expresar «0035 sí y 0036 no y 0037 sí», que un
 *      corte por prefijo no puede.
 *   2. El calce de esquema: aplicar de a una y ver dónde el catálogo de
 *      columnas queda igual al del respaldo. Es una PISTA, no una respuesta:
 *      hoy 0033, 0034 y 0035 calzan las tres con el mismo respaldo porque
 *      ninguna cambia columnas. Cuando pasa eso se elige la PRIMERA y se dice
 *      que hubo empate.
 *
 * Por qué la primera y no la última: el runbook manda aplicar estas migraciones
 * ANTES de cargar los datos. Aplicar una que producción no tenía significa
 * correr su relleno declarado sobre tablas vacías, y que nunca toque las filas
 * restauradas. Equivocarse hacia atrás se arregla después (las que faltan se
 * aplican al final, con los datos adentro); equivocarse hacia adelante, no.
 */
export function elegirNivelDelRespaldo({ todas, calces, porLibro, calzaPorLibro, notasLibro }) {
  const notas = [...notasLibro];

  if (porLibro !== null && calzaPorLibro) {
    return { seleccion: porLibro, fuente: "libro-de-produccion", calces, notas };
  }
  if (porLibro !== null && !calzaPorLibro) {
    notas.push(
      "El libro de estado de producción dice una cosa y el esquema del respaldo dice otra: " +
        "las migraciones que el libro da por aplicadas NO reproducen el catálogo de columnas del " +
        "respaldo. O el libro está desactualizado, o producción cambió por fuera de las migraciones. " +
        "Se sigue por el calce de esquema, pero esto hay que mirarlo.",
    );
  }

  if (calces.length === 0) {
    notas.push(
      "NINGÚN punto de la cadena de migraciones reproduce el esquema del respaldo. " +
        "O producción cambió por fuera de las migraciones, o el respaldo es de otro esquema.",
    );
    return { seleccion: todas.map((m) => m.archivo), fuente: "sin-calce", calces, notas };
  }

  if (calces.length > 1) {
    notas.push(
      `El esquema del respaldo calza con ${calces.length} niveles distintos (${calces.join(", ")}): ` +
        "esas migraciones no cambian ninguna columna, así que mirando columnas son indistinguibles. " +
        `Se usa el PRIMERO (${calces[0]}), que es el único que no arriesga aplicar algo que producción no tenía. ` +
        "Quién tiene qué lo sabe supabase/estado-produccion.json, no este script.",
    );
  }
  const corte = todas.findIndex((m) => m.archivo === calces[0]) + 1;
  return { seleccion: todas.slice(0, corte).map((m) => m.archivo), fuente: "calce-de-esquema", calces, notas };
}

/**
 * Levanta un Postgres limpio con las migraciones que tenía la base cuando se
 * sacó el respaldo — no con todas las del repo.
 *
 * Esto no es un detalle: el repo va adelante de producción. La 0038, por
 * ejemplo, agrega `consumption_logs.source` obligatoria y después le quita el
 * default a propósito, para que nadie vuelva a escribir un consumo sin decir
 * de dónde salió. Meter filas de ANTES de la 0038 en un esquema de DESPUÉS
 * obligaría a inventarles un `source` que nadie declaró — justo lo que la
 * migración vino a impedir. El orden correcto para restaurar es: esquema del
 * respaldo, datos del respaldo, y RECIÉN AHÍ las migraciones nuevas, que traen
 * su propio relleno declarado para las filas viejas.
 *
 * Como en Postgres no se puede "deshacer" una migración ya aplicada, se hace en
 * pasadas: bases de exploración desechables que sólo miden, y la base de verdad
 * construida con la selección elegida. Cuarenta migraciones tardan menos de dos
 * segundos, así que sale más barato que adivinar.
 */
export async function baseDePruebas({ tablasRespaldo = null, refRespaldo = null, hoy = new Date() } = {}) {
  const todas = migracionesDelRepo();

  let elegido = { seleccion: todas.map((m) => m.archivo), fuente: "todas-las-del-repo", calces: [], notas: [] };

  if (tablasRespaldo) {
    // --- Pista 1: dónde calza el catálogo de columnas -----------------------
    const calces = [];
    const exploracion = await baseVacia();
    try {
      for (const m of todas) {
        await exploracion.exec(m.sql);
        const dif = diferenciasDeEsquema((await esquemaDe(exploracion)).tablas, tablasRespaldo);
        if (dif.length === 0) calces.push(m.archivo);
        else if (calces.length > 0) break; // ya pasamos el tramo que calza
      }
    } finally {
      await exploracion.close();
    }

    // --- Fuente 1: el libro de producción -----------------------------------
    const libro = libroDeProduccion({ refEsperado: refRespaldo, hoy });
    const notasLibro = [];
    let porLibro = null;
    let calzaPorLibro = false;
    if (!libro.usable) {
      notasLibro.push(`No se pudo usar el libro de estado de producción: ${libro.motivo}`);
    } else {
      const cambiadas = todas.filter((m) => {
        const sha = libro.shas.get(m.archivo);
        return sha !== undefined && sha !== m.sha256;
      });
      if (cambiadas.length > 0) {
        notasLibro.push(
          `El libro de producción quedó viejo: ${cambiadas.map((m) => m.archivo).join(", ")} cambió de contenido ` +
            "desde que se verificó. Lo que el libro dice de esas migraciones ya no describe lo que hay en el repo.",
        );
      } else {
        porLibro = todas.filter((m) => libro.aplicadas.has(m.archivo)).map((m) => m.archivo);
        calzaPorLibro =
          diferenciasDeEsquema(await esquemaTras(porLibro, todas), tablasRespaldo).length === 0;
      }
    }

    elegido = elegirNivelDelRespaldo({ todas, calces, porLibro, calzaPorLibro, notasLibro });
  }

  const db = await baseVacia();
  const porArchivo = new Map(todas.map((m) => [m.archivo, m]));
  const aplicadas = elegido.seleccion.map((a) => porArchivo.get(a));
  for (const m of aplicadas) {
    try {
      await db.exec(m.sql);
    } catch (e) {
      await db.close();
      throw new Error(`La migración ${m.archivo} no aplica en PGlite: ${e}`);
    }
  }
  const enSeleccion = new Set(elegido.seleccion);
  return {
    db,
    aplicadas,
    todas,
    sobrantes: todas.filter((m) => !enSeleccion.has(m.archivo)).map((m) => m.archivo),
    nivel: elegido.seleccion.length > 0 ? elegido.seleccion[elegido.seleccion.length - 1] : null,
    fuente: elegido.fuente,
    calces: elegido.calces,
    notas: elegido.notas,
  };
}

// ---------------------------------------------------------------------------
// SQL: identificadores, literales y expresiones por tipo
// ---------------------------------------------------------------------------

export function ident(nombre) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(nombre)) {
    // Los nombres salen del catálogo de Postgres, no del usuario; si alguno
    // trae comillas o algo raro se para acá en vez de armar SQL torcido.
    throw new Error(`Identificador inesperado: ${JSON.stringify(nombre)}`);
  }
  return `"${nombre}"`;
}

export function literal(texto) {
  if (texto.includes(NUL)) {
    throw new Error("El texto trae un byte NUL: Postgres no lo acepta en `text`.");
  }
  return `'${texto.split("'").join("''")}'`;
}

/**
 * Cómo se LEE una columna para el respaldo.
 *
 * Todo sale como TEXTO, incluidos los `numeric`. No es capricho: `JSON.parse`
 * de JavaScript convierte cualquier número a coma flotante de 64 bits, así que
 * un `numeric(12,4)` de gramos volvería del respaldo con otro valor. En texto
 * el número viaja tal cual y vuelve a entrar con su tipo exacto.
 *
 * Fechas y horas se formatean a mano en UTC en vez de `::text`, porque `::text`
 * depende de `DateStyle` y del huso de la sesión — dos ajustes que el respaldo
 * no controla y que pueden ser distintos en el destino.
 */
export function expresionLectura(columna, alias = "t") {
  const col = `${alias}.${ident(columna.nombre)}`;
  switch (columna.tipo) {
    case "timestamp with time zone":
      return `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
    case "timestamp without time zone":
      return `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
    case "date":
      return `to_char(${col}, 'YYYY-MM-DD')`;
    default:
      return `${col}::text`;
  }
}

/** Cómo vuelve a ENTRAR esa columna: el espejo exacto de `expresionLectura`. */
export function expresionEscritura(columna, origen = "r") {
  const valor = `(${origen}->>${literal(columna.nombre)})`;
  switch (columna.tipo) {
    case "timestamp with time zone":
      return `(${valor}::timestamp at time zone 'UTC')`;
    case "timestamp without time zone":
      return `${valor}::timestamp`;
    case "date":
      return `${valor}::date`;
    default:
      return `${valor}::${columna.tipo}`;
  }
}

/**
 * Orden total y estable de las filas de una tabla.
 *
 * `collate "C"` no es decoración: ordenar texto con la intercalación local da
 * un orden distinto en Supabase (en_US.UTF-8) que en PGlite, y entonces el
 * hash del respaldo y el hash de lo restaurado no calzarían aunque los datos
 * fueran idénticos. "C" ordena por byte y es igual en todas partes.
 */
export function ordenDe(tabla, alias = "t") {
  const claves = tabla.pk.length > 0 ? tabla.pk : tabla.columnas.map((c) => c.nombre);
  return claves.map((c) => `${alias}.${ident(c)}::text collate "C"`).join(", ");
}

/** Columnas que el respaldo guarda: las derivadas las recalcula la base. */
export function columnasGuardadas(tabla) {
  return tabla.columnas.filter((c) => !c.derivada);
}

/**
 * Arma el objeto JSON de una fila.
 *
 * Se parte en grupos de 40 columnas porque `jsonb_build_object` recibe dos
 * argumentos por columna y Postgres corta las funciones en 100 argumentos.
 * `inventory_lots` ya va en 30 columnas: el margen es más chico de lo que
 * parece.
 */
export function expresionFila(tabla, alias = "t") {
  const cols = columnasGuardadas(tabla);
  const grupos = [];
  for (let i = 0; i < cols.length; i += 40) {
    const parte = cols
      .slice(i, i + 40)
      .map((c) => `${literal(c.nombre)}, ${expresionLectura(c, alias)}`)
      .join(", ");
    grupos.push(`jsonb_build_object(${parte})`);
  }
  return grupos.join(" || ");
}

// ---------------------------------------------------------------------------
// Introspección
// ---------------------------------------------------------------------------

/**
 * Esquema real del destino, leído del catálogo. Sirve para los dos lados: en
 * producción arma el respaldo, y en el ensayo permite comparar columna por
 * columna contra lo que el archivo trae.
 */
export const SQL_ESQUEMA = `
with cols as (
  select c.oid, c.relname as tabla, a.attname as nombre, a.attnum,
         format_type(a.atttypid, a.atttypmod) as tipo,
         a.attgenerated <> '' as derivada,
         a.attidentity <> '' as identidad,
         a.attnotnull as obligatoria,
         a.atthasdef as con_default
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where c.relkind = 'r'
),
pks as (
  select i.indrelid as oid, jsonb_agg(a.attname order by k.ord) as columnas
  from pg_index i
  cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
  where i.indisprimary
  group by i.indrelid
)
select jsonb_build_object(
  'servidor', version(),
  'base', current_database(),
  'momento', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
  'tablas', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'nombre', t.tabla,
      'pk', coalesce(p.columnas, '[]'::jsonb),
      'columnas', t.columnas
    ) order by t.tabla), '[]'::jsonb)
    from (
      select tabla, oid, jsonb_agg(jsonb_build_object(
        'nombre', nombre, 'tipo', tipo, 'derivada', derivada, 'identidad', identidad,
        'obligatoria', obligatoria, 'con_default', con_default
      ) order by attnum) as columnas
      from cols group by tabla, oid
    ) t
    left join pks p on p.oid = t.oid
  ),
  'fks', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'nombre', k.conname,
      'hijo', hijo.relname,
      'cols_hijo', (select jsonb_agg(a.attname order by u.ord)
                    from unnest(k.conkey) with ordinality u(n, ord)
                    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n),
      'padre_esquema', pn.nspname,
      'padre', padre.relname,
      'cols_padre', (select jsonb_agg(a.attname order by u.ord)
                     from unnest(k.confkey) with ordinality u(n, ord)
                     join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n)
    ) order by k.conname), '[]'::jsonb)
    from pg_constraint k
    join pg_class hijo on hijo.oid = k.conrelid
    join pg_namespace hn on hn.oid = hijo.relnamespace and hn.nspname = 'public'
    join pg_class padre on padre.oid = k.confrelid
    join pg_namespace pn on pn.oid = padre.relnamespace
    where k.contype = 'f'
  )
) as esquema
`;

/**
 * `auth.users` NO se respalda entera a propósito.
 *
 * Esa tabla guarda el hash de la contraseña y los tokens de recuperación de
 * cada persona. Un archivo con eso adentro, dando vueltas en un disco, es un
 * problema mucho más grande que el que este respaldo viene a resolver. Se
 * guardan las tres columnas que sirven para RECONOCER a quién apuntaba cada
 * `household_members.user_id`: el id, el correo y cuándo se creó.
 *
 * Consecuencia declarada: restaurar en un proyecto nuevo NO devuelve las
 * cuentas. Hay que crearlas de nuevo por Supabase Auth y volver a enlazarlas
 * (el restaurador lo hace solo por correo). Está en el runbook.
 */
export const COLUMNAS_AUTH_USERS = [
  { nombre: "id", tipo: "uuid", derivada: false, identidad: false },
  { nombre: "email", tipo: "text", derivada: false, identidad: false },
  { nombre: "created_at", tipo: "timestamp with time zone", derivada: false, identidad: false },
];

export const TABLA_AUTH_USERS = {
  nombre: "users",
  esquema: "auth",
  pk: ["id"],
  columnas: COLUMNAS_AUTH_USERS,
};

// ---------------------------------------------------------------------------
// Forma canónica y hashes
// ---------------------------------------------------------------------------

/**
 * Una fila, siempre escrita igual: las columnas en el orden del esquema y los
 * ausentes como `null` explícito. El hash se calcula sobre esto, así que si
 * dos lados no canonizan igual, la verificación no vale nada.
 */
export function canonizarFila(fila, columnas) {
  const orden = {};
  for (const c of columnas) {
    const v = fila[c.nombre];
    orden[c.nombre] = v === undefined ? null : v;
  }
  return JSON.stringify(orden);
}

export function hashDeFilas(filas, columnas) {
  const h = createHash("sha256");
  for (const fila of filas) {
    h.update(canonizarFila(fila, columnas));
    h.update(SALTO);
  }
  return h.digest("hex");
}

export function sha256(texto) {
  return createHash("sha256").update(texto).digest("hex");
}

// ---------------------------------------------------------------------------
// Armado del archivo de respaldo
// ---------------------------------------------------------------------------

/**
 * TODAS las tablas en UNA sola consulta.
 *
 * Cada llamada a la Management API es su propia transacción. Sacar tabla por
 * tabla daría 80 fotos tomadas en 80 momentos distintos: un lote consumido
 * entre la foto de `inventory_lots` y la de `inventory_movements` deja el
 * respaldo con un movimiento que apunta a un lote que ahí no existe. Una sola
 * sentencia = una sola transacción = una foto coherente de todo.
 *
 * Vive acá y no en `respaldo.mjs` porque la prueba del camino real la usa para
 * generar su respaldo con el MISMO lector de producción. Un round-trip donde el
 * test escribe su propio generador no prueba el generador de verdad.
 */
export function sqlFotoCompleta(tablas) {
  const partes = tablas.map((t) => {
    const esquema = t.esquema ?? "public";
    return (
      `select ${literal(t.nombre)}::text as tabla, ` +
      `(select coalesce(jsonb_agg(${expresionFila(t)} order by ${ordenDe(t)}), '[]'::jsonb) ` +
      `from ${ident(esquema)}.${ident(t.nombre)} t) as filas`
    );
  });
  // `union all` en vez de un `jsonb_build_object` gigante: las funciones de
  // Postgres se cortan en 100 argumentos y acá hay más de 80 tablas.
  return `select jsonb_object_agg(s.tabla, s.filas) as datos from (${partes.join(" union all ")}) s`;
}

/** Una sola tabla. Es el camino de `--por-tabla`, que pierde la coherencia. */
export function sqlTablaSuelta(t) {
  const esquema = t.esquema ?? "public";
  return (
    `select coalesce(jsonb_agg(${expresionFila(t)} order by ${ordenDe(t)}), '[]'::jsonb) as filas ` +
    `from ${ident(esquema)}.${ident(t.nombre)} t`
  );
}

/**
 * Arma el NDJSON completo: cabecera, una línea por tabla y la línea de cierre
 * con el hash de todo lo anterior.
 *
 * Función pura (recibe los datos ya leídos, devuelve texto) para que la prueba
 * del camino real pueda generar un respaldo REAL sin salir a la red, y para que
 * el que escribe y el que lee estén cubiertos por el mismo round-trip. Antes
 * esto vivía suelto adentro de `respaldo.mjs`, donde nada podía ejercitarlo.
 */
export function armarArchivoDeRespaldo({
  tablas,
  datos,
  esquema,
  migraciones,
  proyectoRef,
  inventario,
  coherente,
  generadoEn = new Date().toISOString(),
  duracionMs = 0,
}) {
  const cabecera = {
    tipo: "cabecera",
    version_formato: VERSION_FORMATO,
    generado_en: generadoEn,
    proyecto_ref: proyectoRef,
    servidor: esquema.servidor,
    base: esquema.base,
    momento_servidor_utc: esquema.momento,
    snapshot_coherente: coherente,
    advertencia:
      "CONTIENE DATOS CLÍNICOS DE PERSONAS REALES (exámenes, condiciones y restricciones médicas). " +
      "No se sube a ninguna nube de terceros, no se adjunta a un correo ni a un chat, y no entra al repositorio.",
    auth_users_parcial: {
      columnas: TABLA_AUTH_USERS.columnas.map((c) => c.nombre),
      motivo:
        "auth.users guarda hashes de contraseña y tokens de recuperación. No se respaldan: " +
        "restaurar en un proyecto nuevo exige volver a crear las cuentas y reenlazarlas por correo.",
    },
    storage: inventario,
    migraciones: migraciones.map((m) => ({ archivo: m.archivo, sha256: m.sha256 })),
    esquema: {
      tablas: tablas.map((t) => ({
        nombre: t.nombre,
        esquema: t.esquema ?? "public",
        pk: t.pk,
        columnas: columnasGuardadas(t),
      })),
      fks: esquema.fks,
    },
  };

  const lineas = [JSON.stringify(cabecera)];
  const resumenClinico = [];
  let totalFilas = 0;

  for (const t of tablas) {
    const columnas = columnasGuardadas(t);
    const filas = datos[t.nombre];
    totalFilas += filas.length;
    if (TABLAS_CLINICAS.includes(t.nombre) && filas.length > 0) {
      resumenClinico.push(`${t.nombre}: ${filas.length}`);
    }
    lineas.push(
      JSON.stringify({
        tipo: "tabla",
        nombre: t.nombre,
        esquema: t.esquema ?? "public",
        filas: filas.length,
        sha256: hashDeFilas(filas, columnas),
        datos: filas,
      }),
    );
  }

  const contenido = lineas.join(SALTO) + SALTO;
  const cierre = {
    tipo: "cierre",
    completo: true,
    tablas: tablas.length,
    filas: totalFilas,
    // Hash de TODO lo anterior. Si el archivo se edita o se corta después, el
    // restaurador lo nota antes de tocar una base.
    sha256_contenido: sha256(contenido),
    duracion_ms: duracionMs,
  };

  return {
    texto: contenido + JSON.stringify(cierre) + SALTO,
    cabecera,
    cierre,
    resumenClinico,
    totalFilas,
  };
}

// ---------------------------------------------------------------------------
// Lectura del archivo de respaldo
// ---------------------------------------------------------------------------

/**
 * Abre un respaldo y se niega a devolver nada si el archivo no está COMPLETO.
 *
 * El respaldo se escribe en NDJSON y termina con una línea `cierre` que trae el
 * hash de todo lo anterior. Si el proceso murió a mitad —red cortada, disco
 * lleno, alguien cerró la consola— esa línea no está y el archivo se rechaza
 * acá. Un respaldo truncado que parece bueno es peor que no tener ninguno: se
 * descubre la noche que se necesita.
 */
export function leerRespaldo(ruta) {
  if (!existsSync(ruta)) throw new Error(`No existe el archivo ${ruta}`);
  const texto = readFileSync(ruta, "utf8");
  const lineas = texto.split(SALTO).filter((l) => l.trim() !== "");
  if (lineas.length < 2) throw new Error(`${ruta} tiene ${lineas.length} línea(s): no es un respaldo.`);

  const registros = lineas.map((linea, i) => {
    try {
      return JSON.parse(linea);
    } catch (e) {
      throw new Error(`Línea ${i + 1} de ${ruta} no es JSON: el archivo está corrupto. (${e})`);
    }
  });

  const cabecera = registros[0];
  const cierre = registros[registros.length - 1];

  if (cabecera.tipo !== "cabecera") throw new Error(`${ruta} no empieza con una cabecera.`);
  if (cierre.tipo !== "cierre") {
    throw new Error(
      [
        `${path.basename(ruta)} NO TIENE LÍNEA DE CIERRE: está TRUNCADO.`,
        "El respaldo se cortó a mitad de camino. NO se puede usar para restaurar.",
        "Vuelve a correr `node scripts/respaldo.mjs`.",
      ].join(SALTO),
    );
  }
  if (cabecera.version_formato !== VERSION_FORMATO) {
    throw new Error(
      `${path.basename(ruta)} usa el formato v${cabecera.version_formato} y este script entiende v${VERSION_FORMATO}.`,
    );
  }

  const cuerpo = registros.slice(1, -1);
  const hashCuerpo = sha256(lineas.slice(0, -1).join(SALTO) + SALTO);
  if (hashCuerpo !== cierre.sha256_contenido) {
    throw new Error(
      [
        `${path.basename(ruta)} NO CALZA CON SU PROPIO HASH: el archivo cambió después de crearse.`,
        `  esperado: ${cierre.sha256_contenido}`,
        `  leído:    ${hashCuerpo}`,
        "No se restaura un archivo que no es el que se generó.",
      ].join(SALTO),
    );
  }

  const tablas = cuerpo.filter((r) => r.tipo === "tabla");
  return { cabecera, cierre, tablas, ruta };
}

/** Busca el respaldo más reciente en un directorio. */
export function respaldoMasReciente(directorio) {
  if (!existsSync(directorio)) return null;
  const candidatos = readdirSync(directorio)
    .filter((f) => f.endsWith(".ndjson"))
    .sort();
  return candidatos.length > 0 ? path.join(directorio, candidatos[candidatos.length - 1]) : null;
}
