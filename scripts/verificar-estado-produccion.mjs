#!/usr/bin/env node
/**
 * Le pregunta al Supabase de verdad QUÉ MIGRACIONES TIENE PUESTAS, y deja la
 * respuesta escrita en `supabase/estado-produccion.json`.
 *
 *   node scripts/verificar-estado-produccion.mjs             (solo informa)
 *   node scripts/verificar-estado-produccion.mjs --escribir  (informa y anota)
 *
 * POR QUÉ EXISTE. `gate-schema-parity.test.ts` decía por escrito que garantizaba
 * "schema de test == schema de producción" y levantaba la base con la cadena
 * COMPLETA del repo, incluidas migraciones que producción no tiene. Con eso dio
 * por buena una consulta contra `meal_serving_record_items` (0036) que revienta
 * contra la base real. El gate ahora compara contra lo que producción tiene, y
 * para eso necesita saberlo. Este script es la única forma de saberlo de verdad:
 * lo demás es acordarse.
 *
 * POR QUÉ TESTIGOS Y NO UN HISTORIAL. Acá las migraciones se aplican por la
 * Management API (`scripts/aplicar-migracion.mjs`), no por el CLI de Supabase:
 * no hay tabla de historial que consultar, y un registro paralelo que se escribe
 * a mano miente el día que alguien se salta el paso. La única evidencia honesta
 * de "ya está aplicada" es SU EFECTO. Por eso cada migración del libro declara
 * un TESTIGO: una expresión SQL booleana, falsa antes de aplicarla y verdadera
 * después. Que cada testigo discrimine de verdad lo prueba en PGlite
 * `web/src/integration/estado-produccion.test.ts` — que además IMPORTA este
 * archivo y ejecuta sus funciones (el SQL generado corre contra un Postgres de
 * verdad). Por eso lo de abajo está partido en funciones puras exportadas y un
 * `principal()` que solo corre cuando el script se invoca directo: un guardián
 * que lee texto reconoce la ortografía del último bug; uno que ejecuta vigila
 * la propiedad.
 *
 * EL NÚMERO ES EL CONTRATO. `resolverMigracion()` en `harness.ts` documenta la
 * convención del repo: el sufijo descriptivo lo elige quien escribe la
 * migración, el prefijo NNNN es lo único estable. El libro y el disco se
 * emparejan acá POR NÚMERO, igual que en el lector TS (`estado-produccion.ts`):
 * emparejar por nombre completo hacía que un renombre de sufijo dejara al
 * lector en verde y a este script —el único ESCRITOR del libro, y el remedio
 * que todos los mensajes del lector mandan a correr— negándose a correr, y
 * encima acusando "las migraciones aplicadas están CONGELADAS" por una
 * PENDIENTE que jamás se aplicó. Un número con DOS archivos en el disco es
 * error ruidoso: no se adivina cuál de los dos declara el libro.
 *
 * El token sale de `.env.deploy` en la raíz (ignorado por git), igual que
 * `aplicar-migracion.mjs`, y por el mismo motivo: es un token que corre SQL
 * arbitrario sobre toda la cuenta y la app web no tiene por qué tenerlo cerca.
 * Nunca se imprime.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SALTO = String.fromCharCode(10);
const COMILLAS = new RegExp("^[\"']|[\"']$", "g");
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR_MIGRACIONES = path.join(RAIZ, "supabase", "migrations");
const LIBRO = path.join(RAIZ, "supabase", "estado-produccion.json");
const ENV_DESPLIEGUE = path.join(RAIZ, ".env.deploy");
const ENV_LOCAL = path.join(RAIZ, "web", ".env.local");

/**
 * Cuántos días vale una verificación antes de volver a ser una suposición.
 * El lector (`VIGENCIA_MAXIMA_EN_DIAS.TESTIGOS_EN_VIVO`) audita este mismo
 * número; el test los compara importando los dos, no leyendo el texto.
 */
export const DIAS_DE_VIGENCIA = 90;

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

/** Corte limpio de la corrida, con el código de salida que le corresponde. */
class SalidaControlada extends Error {
  constructor(codigo) {
    super(`salida ${codigo}`);
    this.name = "SalidaControlada";
    this.codigo = codigo;
  }
}

/**
 * Termina la corrida SIN llamar a `process.exit()`.
 *
 * POR QUÉ NO `process.exit()`. En Windows, cortar el proceso con el socket de
 * `fetch` todavía abierto revienta libuv con un assert y el código de salida se
 * pierde: queda 127, que no es ninguno de los que este script usa para decir
 * algo (0 coincide, 2 hay desacuerdos, 1 no se pudo saber). Eso estuvo arreglado
 * SÓLO en el camino del informe, así que los caminos que más importa leer —los
 * de error— seguían muriendo mal y contando 127. Se lanza acá y se atrapa abajo:
 * Node cierra el socket solo y recién ahí el proceso se va con su código.
 */
function salir(mensaje, codigo = 1) {
  console.error(mensaje);
  throw new SalidaControlada(codigo);
}

const ESCRIBIR = process.argv.includes("--escribir");

const TOKEN =
  process.env.SUPABASE_ACCESS_TOKEN ?? delArchivo(ENV_DESPLIEGUE, "SUPABASE_ACCESS_TOKEN");
const URL_SUPABASE =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  delArchivo(ENV_DESPLIEGUE, "NEXT_PUBLIC_SUPABASE_URL") ??
  delArchivo(ENV_LOCAL, "NEXT_PUBLIC_SUPABASE_URL") ??
  "";
const REF = URL_SUPABASE.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? null;

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
  return JSON.parse(texto);
}

/**
 * El prefijo de cuatro dígitos de una migración, o `null` si el nombre no lo
 * trae. La misma regla que `numeroDeMigracion()` del lector TS; que las dos no
 * se separen lo comprueba el test EJECUTANDO ambas sobre los mismos nombres.
 */
export function numeroDeMigracion(nombre) {
  return /^(\d{4})_/.exec(path.basename(nombre))?.[1] ?? null;
}

/**
 * Empareja las entradas del libro con los archivos del disco POR NÚMERO.
 *
 * Devuelve `{ rutaPorClave, problemas }`: el nombre de archivo REAL del disco
 * para cada clave del libro, y la lista de todo lo que impide emparejar. Con
 * problemas no se pregunta nada a la base: si no se sabe contra qué archivo
 * anotar la respuesta, anotarla sería mentir.
 *
 * Pura a propósito (recibe las entradas y el listado del disco): el test la
 * ejecuta con renombres, duplicados y ausencias inventadas, y además el test
 * de humo corre el script entero contra un árbol simulado.
 */
export function emparejarLibroConDisco(entradas, archivosEnDisco) {
  const problemas = [];

  const porNumero = new Map();
  for (const archivo of archivosEnDisco) {
    const numero = numeroDeMigracion(archivo);
    if (numero === null) continue; // sin número no puede ser pareja de nadie; al lector TS le toca gritarlo
    porNumero.set(numero, [...(porNumero.get(numero) ?? []), archivo]);
  }

  const rutaPorClave = new Map();
  for (const [clave, entrada] of entradas) {
    const numero = numeroDeMigracion(clave);
    if (numero === null) {
      problemas.push(
        `${clave}: la clave del libro no empieza con NNNN_ y el número es el contrato; ` +
          `renómbrala en supabase/estado-produccion.json`,
      );
      continue;
    }
    const candidatos = porNumero.get(numero) ?? [];
    if (candidatos.length > 1) {
      problemas.push(
        `${numero}: hay ${candidatos.length} archivos con el mismo número en supabase/migrations ` +
          `(${candidatos.join(", ")}) y no se puede saber cuál declara el libro; renumera el que sobra`,
      );
      continue;
    }
    if (candidatos.length === 0) {
      // OJO con el mensaje: acusar "las migraciones aplicadas están CONGELADAS"
      // por una PENDIENTE que jamás se aplicó es un rojo que enseña a ignorar
      // los rojos. Se dice lo que se sabe, según el estado declarado.
      problemas.push(
        entrada?.estado === "APLICADA"
          ? `${clave}: declarada APLICADA y ningún archivo del disco lleva el número ${numero}. ` +
              `Si producción la tiene puesta, el repo perdió su definición: recupérala del historial.`
          : `${clave}: declarada en el libro y ningún archivo del disco lleva el número ${numero}. ` +
              `Si de verdad nunca se aplicó, saca su entrada del libro y di por qué en el commit.`,
      );
      continue;
    }
    rutaPorClave.set(clave, candidatos[0]);
  }
  return { rutaPorClave, problemas };
}

/**
 * La FORMA que tiene que tener el libro para que este script pueda trabajar.
 *
 * Devuelve la lista de problemas (vacía = forma válida). Es el MISMO contrato
 * que el `LibroSchema` de Zod del lector TS; está replicado en JS puro porque
 * este script corre con `node` pelado (es herramienta de despliegue, no puede
 * depender del toolchain de web/ ni de un loader de TS), y que los dos
 * contratos no se separen no lo sostiene esta prosa: lo sostiene el test, que
 * EJECUTA ambos validadores sobre la misma batería de libros malformados y
 * exige que fallen y acepten exactamente los mismos.
 *
 * Por qué importa validar ANTES de generar SQL: una entrada sin `testigo`
 * llegaba a `literal(e.testigo)` como el texto "undefined", Postgres tiraba
 * 42703 (undefined_column), el bloque exception lo atrapaba como ausencia y el
 * libro malformado salía anotado como el DATO "producción no la tiene" — con
 * `--escribir`, degradando una APLICADA a PENDIENTE. ERROR != VACÍO, también
 * en la entrada.
 */
export function validarFormaDelLibro(crudo) {
  if (typeof crudo !== "object" || crudo === null || Array.isArray(crudo)) {
    return ["el libro no es un objeto JSON"];
  }
  const problemas = [];
  const esFecha = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (typeof crudo.proyecto !== "string" || crudo.proyecto.length === 0) {
    problemas.push("proyecto: falta o no es un texto con contenido");
  }
  if (!esFecha(crudo.verificado_el)) problemas.push("verificado_el: la fecha va en formato AAAA-MM-DD");
  if (!esFecha(crudo.caduca_el)) problemas.push("caduca_el: la fecha va en formato AAAA-MM-DD");
  if (crudo.metodo !== "MANIFIESTO" && crudo.metodo !== "TESTIGOS_EN_VIVO") {
    problemas.push("metodo: tiene que ser MANIFIESTO o TESTIGOS_EN_VIVO");
  }
  if (typeof crudo.migraciones !== "object" || crudo.migraciones === null || Array.isArray(crudo.migraciones)) {
    problemas.push("migraciones: falta o no es un objeto {archivo: entrada}");
    return problemas;
  }
  for (const [clave, e] of Object.entries(crudo.migraciones)) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      problemas.push(`migraciones.${clave}: no es un objeto`);
      continue;
    }
    if (e.estado !== "APLICADA" && e.estado !== "PENDIENTE") {
      problemas.push(`migraciones.${clave}.estado: tiene que ser APLICADA o PENDIENTE`);
    }
    if (e.sha256 !== null && !(typeof e.sha256 === "string" && /^[0-9a-f]{64}$/.test(e.sha256))) {
      problemas.push(`migraciones.${clave}.sha256: tiene que ser un sha256 en hexadecimal, o null`);
    }
    if (typeof e.testigo !== "string" || e.testigo.length === 0) {
      problemas.push(`migraciones.${clave}.testigo: falta o está vacío`);
    }
    if (typeof e.prueba !== "string" || e.prueba.length === 0) {
      problemas.push(`migraciones.${clave}.prueba: falta o está vacía`);
    }
    if (e.solo_en_produccion !== undefined && typeof e.solo_en_produccion !== "boolean") {
      problemas.push(`migraciones.${clave}.solo_en_produccion: si está, es booleano`);
    }
  }
  return problemas;
}

/**
 * Evalúa TODOS los testigos en una sola ida a la base.
 *
 * La función auxiliar vive en `pg_temp` (muere con la sesión, no ensucia el
 * schema — el gate §3 no perdona objetos permanentes que no salgan de una
 * migración) y atrapa exactamente los cinco SQLSTATE de "no existe". Esa es la
 * razón de fondo para evaluar del lado del servidor: acá "no existe la tabla" ES
 * la respuesta "todavía no está aplicada", y hay que distinguirlo de un error de
 * verdad. La Management API devuelve el error como texto, sin código: clasificar
 * por el mensaje sería adivinar.
 *
 * Los cinco nombres de condición de abajo son los mismos cinco SQLSTATE que
 * `esAusenciaDelObjeto()` usa del lado de los tests. Que esta función haga
 * EXACTAMENTE eso —NULL sube como NULL, ausencia da false, cualquier otro error
 * revienta— no lo vigila ningún grep: `estado-produccion.test.ts` genera este
 * SQL con testigos de laboratorio y lo CORRE contra PGlite.
 */
export function sqlDeTodosLosTestigos(entradas) {
  const valores = entradas
    .map(([archivo, e]) => `(${literal(archivo)}, ${literal(e.testigo)})`)
    .join(`,${SALTO}    `);
  return `
create or replace function pg_temp.testigo_presente(p_expresion text)
returns boolean language plpgsql as $fn$
declare v_resultado boolean;
begin
  execute 'select (' || p_expresion || ')' into v_resultado;
  -- Se devuelve TAL CUAL, NULL incluido. Acá vivía un coalesce(v_resultado,
  -- false): iba en la dirección segura, pero convertía "el testigo no supo
  -- contestar" en "la migración no está aplicada", que es un desconocido
  -- disfrazado de dato. Si el testigo de una APLICADA da NULL (un and con NULL,
  -- un select sobre cero filas), con el coalesce el script la anotaba PENDIENTE
  -- y el gate levantaba una base "de producción" a la que le faltan objetos que
  -- en producción SÍ están. El NULL sube hasta JavaScript, que lo declara y
  -- detiene la corrida sin anotar nada.
  return v_resultado;
exception
  when undefined_table or undefined_function or undefined_column
    or undefined_object or invalid_schema_name then
    -- Este false SÍ es un dato: Postgres contestó "ese objeto no existe", que
    -- es exactamente la respuesta "todavía no está aplicada".
    return false;
end $fn$;

select t.archivo, pg_temp.testigo_presente(t.expresion) as presente
from (values
    ${valores}
) as t(archivo, expresion)
order by t.archivo;
`;
}

export function literal(s) {
  return `'${String(s).replaceAll("'", "''")}'`;
}

/**
 * El testigo contesta VERDADERO, FALSO o NO SABE, y son tres cosas distintas.
 * `f.presente === true` las aplastaba en dos, dejando "no sabe" del lado de
 * "no aplicada". Acá el "no sabe" no se convierte en nada: va a `mudos`, y con
 * mudos la corrida se detiene sin escribir el libro. Pura y exportada para que
 * el test la alimente con las filas que PGlite devolvió DE VERDAD.
 */
export function clasificarFilas(filas, entradas) {
  const mudos = [];
  const real = new Map();
  for (const f of filas) {
    if (typeof f.presente === "boolean") {
      real.set(f.archivo, f.presente);
      continue;
    }
    const entrada = entradas.find(([archivo]) => archivo === f.archivo)?.[1];
    mudos.push(
      `${f.archivo}: devolvió ${f.presente === null || f.presente === undefined ? "NULL" : String(f.presente)}` +
        `${SALTO}      ${entrada ? entrada.testigo : "(el libro no declara este archivo)"}`,
    );
  }
  return { real, mudos };
}

function hoyISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function principal() {
  if (!TOKEN) {
    salir(
      [
        "Falta el token de la Management API, así que NO se puede saber qué tiene producción.",
        "",
        "  1. https://supabase.com/dashboard/account/tokens → «Generate new token»",
        "  2. Pégalo en .env.deploy, en la raíz del repo (ignorado por git):",
        "",
        "       SUPABASE_ACCESS_TOKEN=sbp_...",
        "",
        "No lo pongas en web/.env.local: Next.js carga ese archivo entero en el proceso",
        "del servidor web, y este token corre SQL arbitrario sobre toda la cuenta.",
      ].join(SALTO),
    );
  }
  if (!REF) salir("No se pudo deducir el ref del proyecto desde NEXT_PUBLIC_SUPABASE_URL.");

  const libro = JSON.parse(readFileSync(LIBRO, "utf8"));

  // -------------------------------------------------------------------------
  // Primero la FORMA, antes de armar una sola sentencia: una entrada sin
  // testigo no puede llegar a literal() como "undefined" y volver de la base
  // disfrazada de "producción no la tiene". Ver validarFormaDelLibro.
  // -------------------------------------------------------------------------
  const malformado = validarFormaDelLibro(libro);
  if (malformado.length > 0) {
    salir(
      [
        "supabase/estado-produccion.json no tiene la forma que este script necesita:",
        ...malformado.map((m) => `  · ${m}`),
        "",
        "No se le pregunta nada a la base: un libro malformado no genera testigos",
        "de verdad, y lo que la base respondiera quedaría anotado como dato.",
      ].join(SALTO),
    );
  }

  const entradas = Object.entries(libro.migraciones).sort(([a], [b]) => a.localeCompare(b));

  // -------------------------------------------------------------------------
  // Libro <-> disco POR NÚMERO (el número es el contrato; ver el encabezado).
  // Después, que el repo esté consigo mismo: si una migración declarada
  // APLICADA ya no es el archivo que se aplicó, lo que la base responda no se
  // puede anotar contra ese archivo sin mentir.
  // -------------------------------------------------------------------------
  const archivosEnDisco = readdirSync(DIR_MIGRACIONES).filter((f) => f.endsWith(".sql"));
  const { rutaPorClave, problemas } = emparejarLibroConDisco(entradas, archivosEnDisco);
  if (problemas.length > 0) {
    salir(
      [
        "El libro y supabase/migrations no calzan; arregla esto antes de verificar:",
        ...problemas.map((p) => `  · ${p}`),
      ].join(SALTO),
    );
  }

  const desalineadas = [];
  for (const [clave, entrada] of entradas) {
    if (entrada.sha256 === null) continue;
    const enDisco = rutaPorClave.get(clave);
    const real = createHash("sha256")
      .update(readFileSync(path.join(DIR_MIGRACIONES, enDisco)))
      .digest("hex");
    if (real !== entrada.sha256) {
      desalineadas.push(
        `${enDisco}: el libro dice ${entrada.sha256.slice(0, 12)}… y el archivo vale ${real.slice(0, 12)}…`,
      );
    }
  }
  if (desalineadas.length > 0) {
    salir(
      [
        "El repo no está consigo mismo; arregla esto antes de verificar contra producción:",
        ...desalineadas.map((d) => `  · ${d}`),
        "",
        "Las migraciones aplicadas están CONGELADAS: si una cambió, producción y el repo",
        "dejaron de ser lo mismo y el cambio va en una migración NUEVA.",
      ].join(SALTO),
    );
  }

  console.log(`Preguntándole al proyecto ${REF} qué migraciones tiene puestas…`);

  let filas;
  try {
    const respuesta = await ejecutar(sqlDeTodosLosTestigos(entradas));
    // La API devuelve las filas del último statement. Si algún día cambiara de
    // forma, esto se detiene: preferimos no saber a creer que sabemos.
    filas = Array.isArray(respuesta) ? respuesta : null;
  } catch (e) {
    if (e instanceof SalidaControlada) throw e;
    salir(`No se pudo consultar: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!filas || filas.length !== entradas.length) {
    salir(
      [
        `La base respondió ${filas ? filas.length : "algo que no es una lista"} y se esperaban`,
        `${entradas.length} filas, una por migración. No se anota nada.`,
        "",
        "ERROR != VACÍO: una respuesta que no se entiende no es 'sin novedad'.",
      ].join(SALTO),
    );
  }

  const { real, mudos } = clasificarFilas(filas, entradas);
  if (mudos.length > 0) {
    salir(
      [
        "Estos testigos no contestaron ni que sí ni que no. No se anota nada:",
        ...mudos.map((m) => `  · ${m}`),
        "",
        "UNKNOWN NO ES CERO Y TAMPOCO ES 'NO APLICADA'. Un testigo que da NULL (un and",
        "con NULL, un select sobre cero filas, un left join sin fila) no está diciendo",
        "que la migración falte: está diciendo que no sabe. Anotarlo como PENDIENTE",
        "haría que el gate levante una base 'de producción' sin objetos que producción",
        "sí tiene, y rechace código que anda perfecto.",
        "",
        "Cómo se arregla: reescribe el testigo para que SIEMPRE dé booleano —envuélvelo",
        "en exists(...), en ... is not null, o en un coalesce EXPLÍCITO si de verdad el",
        "NULL significa ausencia y lo puedes justificar en 'prueba'.",
      ].join(SALTO),
    );
  }

  const desacuerdos = [];
  console.log("");
  for (const [archivo, entrada] of entradas) {
    const enLaBase = real.get(archivo);
    if (enLaBase === undefined) {
      salir(`La base no respondió por ${archivo}. No se anota nada.`);
    }
    const declarado = entrada.estado === "APLICADA";
    const marca = enLaBase === declarado ? " " : "!";
    const dice = enLaBase ? "APLICADA" : "PENDIENTE";
    console.log(
      `${marca} ${archivo.padEnd(46)} ${dice}${marca === "!" ? `  (el libro decía ${entrada.estado})` : ""}`,
    );
    if (enLaBase !== declarado) desacuerdos.push({ archivo, entrada, enLaBase });
  }

  console.log("");
  if (desacuerdos.length === 0) {
    console.log("El libro coincide con la base, migración por migración.");
  } else {
    console.log(`${desacuerdos.length} desacuerdo(s) entre el libro y la base.`);
  }

  if (!ESCRIBIR) {
    console.log("");
    console.log("Modo informe. Para anotar la respuesta en el libro:");
    console.log("  node scripts/verificar-estado-produccion.mjs --escribir");
    return desacuerdos.length === 0 ? 0 : 2;
  }

  for (const { archivo, entrada, enLaBase } of desacuerdos) {
    entrada.estado = enLaBase ? "APLICADA" : "PENDIENTE";
    if (enLaBase && entrada.sha256 === null) {
      // Recién aplicada: el checksum de lo que quedó puesto es el del archivo
      // que hay ahora — el del DISCO, resuelto por número, no la clave del
      // libro, que puede traer el sufijo viejo. De acá en adelante queda
      // congelado y el libro lo vigila.
      entrada.sha256 = createHash("sha256")
        .update(readFileSync(path.join(DIR_MIGRACIONES, rutaPorClave.get(archivo))))
        .digest("hex");
    }
  }

  const hoy = new Date();
  const vence = new Date(hoy.getTime() + DIAS_DE_VIGENCIA * 24 * 60 * 60 * 1000);
  libro.verificado_el = hoyISO(hoy);
  libro.caduca_el = hoyISO(vence);
  libro.metodo = "TESTIGOS_EN_VIVO";

  writeFileSync(LIBRO, `${JSON.stringify(libro, null, 2)}${SALTO}`, "utf8");
  console.log("");
  console.log(
    `Libro actualizado: verificado_el=${libro.verificado_el}, caduca_el=${libro.caduca_el}.`,
  );
  console.log("Corre los tests: el gate de paridad ya compara contra esto.");
  return 0;
}

/**
 * Solo corre como programa cuando lo invocan directo (`node scripts/...`).
 * Cuando el test lo IMPORTA para ejecutar sus funciones, acá no pasa nada:
 * importar no puede disparar una consulta a producción. La comparación es
 * insensible a mayúsculas por la letra de unidad de Windows (C:\ vs c:\).
 */
const esEjecucionDirecta =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() ===
    fileURLToPath(import.meta.url).toLowerCase();

if (esEjecucionDirecta) {
  // El único lugar donde se decide el código de salida, y siempre por
  // `process.exitCode`: ver el porqué en `salir()`. Nada acá llama a
  // `process.exit()`, ni siquiera para lo inesperado.
  try {
    process.exitCode = await principal();
  } catch (e) {
    if (e instanceof SalidaControlada) {
      process.exitCode = e.codigo;
    } else {
      // Un error que este script no previó no se disfraza de "no se pudo
      // consultar": se muestra entero, con su stack, y sale con 1.
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exitCode = 1;
    }
  }
}
