#!/usr/bin/env node
/**
 * Construye STAGING desde cero. Y si ya existe, lo deja igual (idempotente).
 *
 *   node scripts/staging-bootstrap.mjs --en-seco                 (imprime el plan; no toca nada)
 *   node scripts/staging-bootstrap.mjs --ref <proyecto> --en-seco (lee staging y muestra qué le falta)
 *   node scripts/staging-bootstrap.mjs --ref <proyecto>           (construye o completa)
 *
 * El ref de staging también puede venir en STAGING_PROJECT_REF o deducirse de
 * E2E_SUPABASE_URL en web/.env.staging.local. Da lo mismo por dónde llegue:
 * SIEMPRE se compara contra el ref de producción y, si son el mismo, se corta.
 *
 * POR QUÉ EXISTE. Los E2E de Playwright (web/e2e) corren SOLO contra staging:
 * la app habla PostgREST y PGlite no lo tiene, y contra la base de la familia
 * no se prueba nada. Hoy (2026-09-02) staging NO existe —la organización tiene
 * un solo proyecto, producción—, así que este script se escribió y se probó en
 * seco y por sus piezas, y quedó NO CORRIDO contra un proyecto vivo. Está dicho
 * acá y en docs/deployment/staging.md.
 *
 * QUÉ HACE, en orden, y CON QUÉ:
 *
 *   1. Migraciones: la cadena COMPLETA, en el orden del arnés. No la aplica
 *      este script: se la pide a `scripts/poner-al-dia.mjs --ref <staging>`,
 *      que lee el orden de `web/src/integration/harness.ts` y aplica con
 *      `aplicar-migracion.mjs`. Un segundo aplicador "para staging" sería un
 *      segundo orden, y dos dueños del orden es exactamente cómo el repo y
 *      producción se separaron una vez.
 *
 *      Qué le FALTA a staging lo dicen los TESTIGOS del libro
 *      (`supabase/estado-produccion.json`), preguntados a staging en vivo con
 *      el mismo SQL que usa `verificar-estado-produccion.mjs`. Es lo que hace
 *      idempotente la corrida: la segunda vez el plan sale vacío.
 *
 *   2. Contenido: los tres seeds y las 452 recetas, con
 *      `scripts/publicar-recetario.mjs --ref <staging> --aplicar`, que trae un
 *      testigo por seed (el catálogo NO es idempotente: revienta contra una fila
 *      que ya existe, y el testigo es lo único que lo evita).
 *
 *   3. Cuentas sintéticas por la Auth Admin API de GoTrue: A y B en el mismo
 *      hogar (A crea el hogar con `create_household` y B entra por una
 *      invitación real aceptada con `accept_invitation`, el mismo camino que
 *      la app), AJENO en otro hogar, y un dependiente sin cuenta en el hogar de
 *      A. Las contraseñas salen de web/.env.staging.local —el mismo archivo que
 *      lee Playwright— para que haya un solo dueño de ese dato.
 *
 *   4. Buckets: los crean las migraciones (0026 `medical-documents`, 0045
 *      `purchase-receipts`; la 0034 les pone las políticas). Acá solo se
 *      comprueba que estén.
 *
 *   5. Auth de staging (PATCH /config/auth): `site_url` = E2E_BASE_URL, la
 *      lista de redirecciones, y `mailer_autoconfirm = true`. En PRODUCCIÓN ese
 *      valor va en FALSE: staging confirma el correo solo porque los E2E no
 *      leen buzones; una cuenta de la familia sí tiene que confirmar el suyo.
 *
 *   6. Humo: todos los testigos verdaderos, conteos de recetas y alimentos,
 *      cuentas y hogares como se declararon, y que web/.env.staging.local tenga
 *      lo que el contrato de Playwright (web/e2e/fixtures/contrato.ts) exige.
 *
 * LO QUE NUNCA HACE: imprimir la service_role, la anon key o el token; escribir
 * en el proyecto de producción (la guarda de ref es lo primero que corre, antes
 * de cualquier red); tocar un proyecto que tenga hogares que este script no
 * creó (un staging construido acá solo tiene hogares con los nombres de abajo).
 *
 * Las funciones puras van exportadas y `principal()` corre solo cuando se
 * invoca directo: `web/src/integration/staging-bootstrap.test.ts` las ejecuta
 * (plan, guardas, diff de auth) sin tocar ninguna red.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  clasificarFilas,
  numeroDeMigracion,
  sqlDeTodosLosTestigos,
  validarFormaDelLibro,
} from "./verificar-estado-produccion.mjs";

const SALTO = String.fromCharCode(10);
const COMILLAS = new RegExp("^[\"']|[\"']$", "g");
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(RAIZ, "web", "src", "integration", "harness.ts");
const LIBRO = path.join(RAIZ, "supabase", "estado-produccion.json");
const ENV_DESPLIEGUE = path.join(RAIZ, ".env.deploy");
const ENV_LOCAL = path.join(RAIZ, "web", ".env.local");
/**
 * `.env.staging.local` y no `.env.staging`: la raíz ignora `.env*.local`, y un
 * archivo con la service_role de staging que git no ignore termina en un
 * commit. El nombre es parte de la protección.
 */
export const ENV_STAGING = path.join(RAIZ, "web", ".env.staging.local");
const PONER_AL_DIA = path.join(RAIZ, "scripts", "poner-al-dia.mjs");
const PUBLICAR_RECETARIO = path.join(RAIZ, "scripts", "publicar-recetario.mjs");

/**
 * Los nombres con que este script deja sus huellas en staging. Son también la
 * guarda: un proyecto con un hogar que NO se llame así tiene datos que este
 * script no creó, y no se toca.
 */
export const NOMBRES = {
  hogarAB: "Hogar E2E de A y B",
  hogarAjeno: "Hogar E2E ajeno",
  personaA: "Ana E2E",
  personaB: "Beto E2E",
  personaAjena: "Carla E2E (ajena)",
  dependiente: "Dani E2E (sin cuenta)",
};

/**
 * Lo que web/e2e/fixtures/contrato.ts espera encontrar en el entorno. Nombres,
 * nunca valores. El script exige las que necesita para construir (correos y
 * contraseñas, E2E_BASE_URL) y comprueba en el humo las que Playwright necesita
 * además (llaves), sin imprimir ninguna.
 */
export const VARIABLES_E2E = [
  "E2E_BASE_URL",
  "E2E_SUPABASE_URL",
  "E2E_SUPABASE_ANON_KEY",
  "E2E_SUPABASE_SERVICE_ROLE_KEY",
  "E2E_USER_A_EMAIL",
  "E2E_USER_A_PASSWORD",
  "E2E_USER_B_EMAIL",
  "E2E_USER_B_PASSWORD",
  "E2E_USER_AJENO_EMAIL",
  "E2E_USER_AJENO_PASSWORD",
];

/** Las que hacen falta para CONSTRUIR (las llaves se obtienen por la API). */
export const VARIABLES_PARA_CONSTRUIR = [
  "E2E_BASE_URL",
  "E2E_USER_A_EMAIL",
  "E2E_USER_A_PASSWORD",
  "E2E_USER_B_EMAIL",
  "E2E_USER_B_PASSWORD",
  "E2E_USER_AJENO_EMAIL",
  "E2E_USER_AJENO_PASSWORD",
];

/** Los buckets que las migraciones tienen que haber dejado. */
export const BUCKETS_ESPERADOS = ["medical-documents", "purchase-receipts"];

/**
 * Cuántas recetas publicadas tiene que haber como mínimo. Es el número que
 * declara `publicar-recetario.mjs` (452 de la biblioteca); el humo imprime el
 * real y exige que no sea menor. No se exige igualdad porque los seeds
 * anteriores publican otras (las 14 del catálogo de demo) y el número exacto
 * lo decide el contenido, no este script.
 */
export const RECETAS_MINIMAS = 452;

// ---------------------------------------------------------------------------
// Salida controlada (sin process.exit: ver aplicar-migracion.mjs)
// ---------------------------------------------------------------------------

class SalidaControlada extends Error {
  constructor(codigo) {
    super(`salida ${codigo}`);
    this.name = "SalidaControlada";
    this.codigo = codigo;
  }
}

function salir(mensaje, codigo = 1) {
  console.error(mensaje);
  throw new SalidaControlada(codigo);
}

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

/** Una variable E2E: primero el entorno, después web/.env.staging.local. */
function variableE2E(nombre) {
  const del = process.env[nombre];
  if (del !== undefined && del !== "") return del;
  return delArchivo(ENV_STAGING, nombre);
}

const sha256 = (texto) => createHash("sha256").update(texto).digest("hex");

// ---------------------------------------------------------------------------
// Piezas puras (las prueba staging-bootstrap.test.ts)
// ---------------------------------------------------------------------------

/**
 * Argumentos. `--ref` con la misma regla que en los otros scripts: sin valor
 * corta, no cae a producción.
 */
export function extraerArgumentos(argv) {
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
  const conocidas = new Set(["--en-seco", "--desconocidas-como-ausentes"]);
  const desconocidas = resto.filter((a) => a.startsWith("--") && !conocidas.has(a));
  if (desconocidas.length > 0) {
    throw new Error(`Opción desconocida: ${desconocidas.join(", ")}. Las que hay: --ref, --en-seco, --desconocidas-como-ausentes.`);
  }
  return {
    ref,
    enSeco: resto.includes("--en-seco"),
    desconocidasComoAusentes: resto.includes("--desconocidas-como-ausentes"),
  };
}

/** El ref de un proyecto a partir de su URL pública, o null. */
export function refDeUrl(url) {
  return String(url ?? "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? null;
}

/**
 * La cadena, en el orden del arnés. Este script es un LECTOR de esa lista con
 * la misma expresión que usan poner-al-dia.mjs y db-test.sh; el dueño del orden
 * sigue siendo harness.ts, y quien la aplica es poner-al-dia.mjs.
 */
export function ordenDelArnes(textoDelArnes) {
  const bloque = textoDelArnes.match(/const MIGRACIONES\s*=\s*\[([\s\S]*?)\];/);
  if (!bloque) throw new Error("No pude leer la lista MIGRACIONES del arnés; sin orden no se construye nada.");
  const archivos = [...bloque[1].matchAll(/"supabase\/migrations\/([^"]+)"/g)].map((m) => m[1]);
  if (archivos.length === 0) throw new Error("La lista MIGRACIONES del arnés vino vacía.");
  return archivos;
}

/**
 * LA GUARDA QUE VA ANTES QUE TODO. Devuelve el motivo para no seguir, o null.
 *
 * Sin ref no se construye nada: "staging" no es un valor por defecto. Y un ref
 * igual al de producción se corta aunque alguien lo haya escrito a mano: el
 * script escribe cuentas, hogares y config de Auth, y sobre la base de la
 * familia eso no es un ensayo, es un incidente.
 */
export function motivoParaNoTocar({ refStaging, refProduccion }) {
  if (!refStaging) {
    return [
      "No sé cuál es el proyecto de staging.",
      "Dímelo con --ref <proyecto>, con STAGING_PROJECT_REF en el entorno, o con",
      "E2E_SUPABASE_URL en web/.env.staging.local. No hay valor por defecto a propósito.",
    ].join(SALTO);
  }
  if (refProduccion && refStaging === refProduccion) {
    return [
      `El ref ${refStaging} ES EL DE PRODUCCIÓN (el que declara NEXT_PUBLIC_SUPABASE_URL).`,
      "Este script crea cuentas, hogares y cambia la configuración de Auth. Contra la",
      "base de la familia no se corre ni en seco. Staging es OTRO proyecto.",
    ].join(SALTO);
  }
  return null;
}

/**
 * Qué tiene puesto staging, migración por migración: PRESENTE, AUSENTE o
 * DESCONOCIDO. Empareja la cadena con el libro POR NÚMERO (el número es el
 * contrato, como en el verificador), y con las filas que los testigos
 * contestaron. Una migración sin entrada en el libro es DESCONOCIDA: no hay
 * testigo que preguntarle, y sin testigo no se adivina.
 */
export function clasificarCadena(orden, entradasDelLibro, presentesPorClave) {
  const clavePorNumero = new Map();
  for (const [clave] of entradasDelLibro) {
    const n = numeroDeMigracion(clave);
    if (n !== null) clavePorNumero.set(n, clave);
  }
  const estados = new Map();
  for (const archivo of orden) {
    const clave = clavePorNumero.get(numeroDeMigracion(archivo));
    if (clave === undefined) {
      estados.set(archivo, "DESCONOCIDO");
      continue;
    }
    const presente = presentesPorClave.get(clave);
    if (presente === true) estados.set(archivo, "PRESENTE");
    else if (presente === false) estados.set(archivo, "AUSENTE");
    else estados.set(archivo, "DESCONOCIDO");
  }
  return estados;
}

/**
 * Qué aplicar, en el orden del arnés.
 *
 * Reglas, y por qué cada una:
 *
 *   · Si la PRIMERA de la cadena está AUSENTE, la base está vacía (todo lo
 *     demás depende de ella): se aplica todo, DESCONOCIDAS incluidas. Sobre una
 *     base vacía nada se puede aplicar dos veces.
 *   · Si hay algo PRESENTE, lo presente tiene que ser un PREFIJO de la cadena.
 *     Una AUSENTE antes de la última PRESENTE es una base a medio migrar por
 *     otro camino, y acá no se rellenan huecos: se dice y se corta.
 *   · Una DESCONOCIDA antes de la última PRESENTE se infiere PRESENTE, porque
 *     la cadena solo se aplica en orden y se detiene al primer fallo. Se
 *     declara la inferencia en `notas`.
 *   · Una DESCONOCIDA después de la última PRESENTE NO se aplica: podría estar
 *     puesta (y reventar) o no. UNKNOWN ≠ AUSENTE. Se corta, salvo que se pida
 *     explícitamente `--desconocidas-como-ausentes`, y eso queda impreso.
 */
export function planDeMigraciones(orden, estados, { desconocidasComoAusentes = false } = {}) {
  const notas = [];
  const primera = orden[0];
  if (primera === undefined) throw new Error("La cadena vino vacía.");

  if (estados.get(primera) === "AUSENTE") {
    const desconocidas = orden.filter((f) => estados.get(f) === "DESCONOCIDO");
    if (desconocidas.length > 0) {
      notas.push(
        `Base vacía: ${desconocidas.length} migración(es) sin testigo en el libro se aplican igual ` +
          `(${desconocidas.join(", ")}). Sobre una base vacía no hay nada que aplicar dos veces.`,
      );
    }
    return { plan: [...orden], notas };
  }

  let ultimoPresente = -1;
  orden.forEach((f, i) => {
    if (estados.get(f) === "PRESENTE") ultimoPresente = i;
  });

  if (ultimoPresente === -1) {
    // Nada presente y la primera no está AUSENTE: la primera es DESCONOCIDA, o
    // sea que el libro no tiene ni el testigo de la 0001. No se sabe nada.
    throw new Error(
      `No sé si ${primera} está puesta (sin testigo en el libro) y nada más contestó PRESENTE. ` +
        "Sin saber eso no se aplica nada.",
    );
  }

  const huecos = orden.slice(0, ultimoPresente).filter((f) => estados.get(f) === "AUSENTE");
  if (huecos.length > 0) {
    throw new Error(
      [
        `Staging está A MEDIO MIGRAR por otro camino: ${orden[ultimoPresente]} está puesta y antes faltan`,
        ...huecos.map((f) => `   ${f}`),
        "La cadena se aplica en orden y no se rellenan huecos. Revisa ese proyecto a mano",
        "(o bórralo y construye staging desde cero).",
      ].join(SALTO),
    );
  }

  const inferidas = orden.slice(0, ultimoPresente).filter((f) => estados.get(f) === "DESCONOCIDO");
  if (inferidas.length > 0) {
    notas.push(
      `Se dan por PRESENTES (inferido: la cadena solo se aplica en orden y hay una posterior puesta): ` +
        inferidas.join(", "),
    );
  }

  const despues = orden.slice(ultimoPresente + 1);
  const desconocidasDespues = despues.filter((f) => estados.get(f) === "DESCONOCIDO");
  if (desconocidasDespues.length > 0 && !desconocidasComoAusentes) {
    throw new Error(
      [
        `${desconocidasDespues.length} migración(es) sin testigo en el libro, después de la última puesta (${orden[ultimoPresente]}):`,
        ...desconocidasDespues.map((f) => `   ${f}`),
        "No sé si staging las tiene. UNKNOWN no es AUSENTE: aplicarlas a ciegas puede",
        "reventar sobre una que ya está, y saltarlas deja la cadena con un hueco.",
        "Agrégales su testigo a supabase/estado-produccion.json (el lead lo engancha), o",
        "si SABES que este staging nunca las recibió, corre con --desconocidas-como-ausentes.",
      ].join(SALTO),
    );
  }
  if (desconocidasDespues.length > 0) {
    notas.push(
      `Por --desconocidas-como-ausentes se aplican sin testigo: ${desconocidasDespues.join(", ")}`,
    );
  }
  return { plan: despues, notas };
}

/** Hogares del proyecto que este script NO creó. Con uno solo, no se toca. */
export function hogaresAjenos(nombresEnLaBase, propios = [NOMBRES.hogarAB, NOMBRES.hogarAjeno]) {
  const permitidos = new Set(propios);
  return nombresEnLaBase.filter((n) => !permitidos.has(n));
}

/** La configuración de Auth que staging tiene que tener. */
export function configAuthDeseada(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, "");
  return {
    site_url: base,
    // Las de siempre para desarrollar, más la de la app bajo prueba (sin
    // repetir cuando la app bajo prueba ES localhost).
    uri_allow_list: [...new Set([`${base}/**`, "http://localhost:3000/**"])],
    // STAGING confirma el correo solo: los E2E no leen buzones. En PRODUCCIÓN
    // va en false — una cuenta de la familia confirma su correo de verdad.
    mailer_autoconfirm: true,
  };
}

/**
 * Qué hay que cambiar en Auth, o null si ya está como se quiere. La lista de
 * redirecciones se COMPLETA, no se reemplaza: un patrón que alguien agregó a
 * mano (un preview de Vercel, por ejemplo) no se pierde por correr esto.
 */
export function planDeAuth(actual, deseada) {
  const cambios = {};
  if ((actual.site_url ?? "") !== deseada.site_url) cambios.site_url = deseada.site_url;

  const actuales = String(actual.uri_allow_list ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  const faltan = deseada.uri_allow_list.filter((u) => !actuales.includes(u));
  if (faltan.length > 0) cambios.uri_allow_list = [...actuales, ...faltan].join(",");

  if (actual.mailer_autoconfirm !== deseada.mailer_autoconfirm) {
    cambios.mailer_autoconfirm = deseada.mailer_autoconfirm;
  }
  return Object.keys(cambios).length === 0 ? null : cambios;
}

// ---------------------------------------------------------------------------
// Clientes HTTP (Management API, GoTrue, PostgREST). Ninguno imprime llaves.
// ---------------------------------------------------------------------------

async function leerRespuesta(r, queEra) {
  const texto = await r.text();
  let cuerpo = texto;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    /* no era JSON: se deja el texto */
  }
  if (!r.ok) {
    const detalle =
      typeof cuerpo === "object" && cuerpo !== null
        ? cuerpo.message ?? cuerpo.msg ?? cuerpo.error_description ?? cuerpo.error ?? texto
        : texto;
    throw new Error(`${queEra} respondió ${r.status}: ${String(detalle).slice(0, 300)}`);
  }
  return cuerpo;
}

function clienteManagement(token) {
  const base = "https://api.supabase.com/v1";
  const cabeceras = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    async proyecto(ref) {
      return leerRespuesta(await fetch(`${base}/projects/${ref}`, { headers: cabeceras }), "Management API (proyecto)");
    },
    async sql(ref, query) {
      return leerRespuesta(
        await fetch(`${base}/projects/${ref}/database/query`, {
          method: "POST",
          headers: cabeceras,
          body: JSON.stringify({ query }),
        }),
        "Management API (SQL)",
      );
    },
    async llaves(ref) {
      const lista = await leerRespuesta(
        await fetch(`${base}/projects/${ref}/api-keys?reveal=true`, { headers: cabeceras }),
        "Management API (api-keys)",
      );
      const de = (nombre) => (Array.isArray(lista) ? lista.find((k) => k.name === nombre)?.api_key : undefined);
      const anon = de("anon");
      const serviceRole = de("service_role");
      if (!anon || !serviceRole) {
        throw new Error("La Management API no devolvió las llaves anon y service_role del proyecto.");
      }
      return { anon, serviceRole };
    },
    async configAuth(ref) {
      return leerRespuesta(await fetch(`${base}/projects/${ref}/config/auth`, { headers: cabeceras }), "Management API (config/auth)");
    },
    async patchConfigAuth(ref, cambios) {
      return leerRespuesta(
        await fetch(`${base}/projects/${ref}/config/auth`, {
          method: "PATCH",
          headers: cabeceras,
          body: JSON.stringify(cambios),
        }),
        "Management API (PATCH config/auth)",
      );
    },
  };
}

function clienteAuth(urlProyecto, llaves) {
  const base = `${urlProyecto}/auth/v1`;
  const admin = { apikey: llaves.serviceRole, Authorization: `Bearer ${llaves.serviceRole}`, "Content-Type": "application/json" };
  return {
    async usuarios() {
      const r = await leerRespuesta(
        await fetch(`${base}/admin/users?page=1&per_page=1000`, { headers: admin }),
        "Auth Admin (listar)",
      );
      return Array.isArray(r?.users) ? r.users : [];
    },
    async crear(email, password) {
      return leerRespuesta(
        await fetch(`${base}/admin/users`, {
          method: "POST",
          headers: admin,
          // email_confirm: la cuenta nace confirmada. Es una cuenta SINTÉTICA
          // de staging; en producción nadie crea cuentas por acá.
          body: JSON.stringify({ email, password, email_confirm: true }),
        }),
        "Auth Admin (crear)",
      );
    },
    async fijarContrasena(id, password) {
      return leerRespuesta(
        await fetch(`${base}/admin/users/${id}`, {
          method: "PUT",
          headers: admin,
          body: JSON.stringify({ password, email_confirm: true }),
        }),
        "Auth Admin (contraseña)",
      );
    },
    /** Inicia sesión COMO el usuario: el token que devuelve es el que usa PostgREST. */
    async entrar(email, password) {
      const r = await leerRespuesta(
        await fetch(`${base}/token?grant_type=password`, {
          method: "POST",
          headers: { apikey: llaves.anon, "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        }),
        `Auth (iniciar sesión como ${email})`,
      );
      if (!r?.access_token || !r?.user?.id) throw new Error(`Auth no devolvió sesión para ${email}.`);
      return { token: r.access_token, id: r.user.id };
    },
  };
}

/** PostgREST como un usuario (RLS activa): exactamente lo que hace la app. */
function clienteRest(urlProyecto, anon, sesion) {
  const base = `${urlProyecto}/rest/v1`;
  const cabeceras = {
    apikey: anon,
    Authorization: `Bearer ${sesion.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  return {
    async leer(tabla, consulta) {
      return leerRespuesta(await fetch(`${base}/${tabla}?${consulta}`, { headers: cabeceras }), `PostgREST (${tabla})`);
    },
    async insertar(tabla, fila) {
      return leerRespuesta(
        await fetch(`${base}/${tabla}`, {
          method: "POST",
          headers: { ...cabeceras, Prefer: "return=representation" },
          body: JSON.stringify(fila),
        }),
        `PostgREST (insertar en ${tabla})`,
      );
    },
    async rpc(funcion, args) {
      return leerRespuesta(
        await fetch(`${base}/rpc/${funcion}`, { method: "POST", headers: cabeceras, body: JSON.stringify(args) }),
        `PostgREST (rpc ${funcion})`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Pasos
// ---------------------------------------------------------------------------

function libroDeProduccion() {
  if (!existsSync(LIBRO)) throw new Error(`No encuentro ${LIBRO}: sin testigos no se sabe qué le falta a staging.`);
  const libro = JSON.parse(readFileSync(LIBRO, "utf8"));
  const problemas = validarFormaDelLibro(libro);
  if (problemas.length > 0) {
    throw new Error(["supabase/estado-produccion.json no tiene la forma esperada:", ...problemas.map((p) => `  · ${p}`)].join(SALTO));
  }
  return libro;
}

/** Los testigos del libro, preguntados a staging. Devuelve Map clave → boolean. */
async function testigosEnVivo(api, ref, libro) {
  const entradas = Object.entries(libro.migraciones).sort(([a], [b]) => a.localeCompare(b));
  if (entradas.length === 0) return { entradas, presentes: new Map() };
  const filas = await api.sql(ref, sqlDeTodosLosTestigos(entradas));
  if (!Array.isArray(filas) || filas.length !== entradas.length) {
    throw new Error(
      `Staging respondió ${Array.isArray(filas) ? filas.length : "algo que no es una lista"} y se esperaban ${entradas.length} filas de testigos. ERROR != VACÍO.`,
    );
  }
  const { real, mudos } = clasificarFilas(filas, entradas);
  if (mudos.length > 0) {
    throw new Error(["Testigos que no contestaron ni sí ni no (UNKNOWN no es AUSENTE):", ...mudos.map((m) => `  · ${m}`)].join(SALTO));
  }
  return { entradas, presentes: real };
}

async function nombresDeHogares(api, ref) {
  const existe = await api.sql(
    ref,
    "select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'households') as hay",
  );
  if (!Array.isArray(existe) || typeof existe[0]?.hay !== "boolean") {
    throw new Error("No pude saber si existe public.households en staging. No sigo a ciegas.");
  }
  if (!existe[0].hay) return [];
  const filas = await api.sql(ref, "select name from public.households order by name");
  if (!Array.isArray(filas)) throw new Error("La lista de hogares de staging no vino como lista.");
  return filas.map((f) => String(f.name));
}

function correrScript(script, args) {
  console.log("");
  console.log(`> node ${path.relative(RAIZ, script)} ${args.join(" ")}`);
  const r = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", cwd: RAIZ });
  if (r.error) throw new Error(`No pude correr ${script}: ${r.error.message}`);
  if (typeof r.status !== "number") throw new Error(`${path.basename(script)} terminó sin código de salida (señal ${r.signal ?? "desconocida"}).`);
  return r.status;
}

/** Deja al usuario creado y con SU contraseña (la del archivo), exista o no. */
async function asegurarCuenta(auth, existentes, email, password) {
  const ya = existentes.find((u) => String(u.email ?? "").toLowerCase() === email.toLowerCase());
  if (ya) {
    // Se fija la contraseña siempre: si alguien la cambió en web/.env.staging.local,
    // la cuenta tiene que seguir a ese archivo, que es el dueño del dato.
    await auth.fijarContrasena(ya.id, password);
    return { id: ya.id, creada: false };
  }
  const creado = await auth.crear(email, password);
  if (!creado?.id) throw new Error(`Auth Admin no devolvió id al crear ${email}.`);
  return { id: creado.id, creada: true };
}

/** Los hogares de un usuario, vistos POR ÉL (RLS): [{ id, household_id }]. */
async function membresiasDe(rest, uid) {
  const filas = await rest.leer("household_members", `select=id,household_id&user_id=eq.${uid}&is_active=eq.true`);
  if (!Array.isArray(filas)) throw new Error("PostgREST no devolvió una lista de integrantes.");
  return filas;
}

async function asegurarHogaresYCuentas({ api, ref, urlProyecto, llaves, correos, bitacora }) {
  const auth = clienteAuth(urlProyecto, llaves);
  const existentes = await auth.usuarios();

  const cuentas = {};
  for (const quien of ["A", "B", "AJENO"]) {
    const { email, password } = correos[quien];
    const r = await asegurarCuenta(auth, existentes, email, password);
    cuentas[quien] = { ...r, email, password };
    bitacora(`cuenta ${quien}: ${r.creada ? "creada" : "ya existía"} (${email})`);
  }

  // --- A: su hogar ---------------------------------------------------------
  const sesionA = await auth.entrar(cuentas.A.email, cuentas.A.password);
  const restA = clienteRest(urlProyecto, llaves.anon, sesionA);
  let hogarAB;
  const deA = await membresiasDe(restA, sesionA.id);
  if (deA.length === 0) {
    hogarAB = await restA.rpc("create_household", { p_name: NOMBRES.hogarAB, p_display_name: NOMBRES.personaA });
    if (typeof hogarAB !== "string") throw new Error("create_household no devolvió el id del hogar de A.");
    bitacora(`hogar de A creado por create_household`);
  } else {
    hogarAB = deA[0].household_id;
    bitacora(`hogar de A ya existía`);
  }

  // --- B: entra por invitación real ------------------------------------------
  const sesionB = await auth.entrar(cuentas.B.email, cuentas.B.password);
  const restB = clienteRest(urlProyecto, llaves.anon, sesionB);
  const deB = await membresiasDe(restB, sesionB.id);
  if (deB.some((m) => m.household_id === hogarAB)) {
    bitacora(`B ya es integrante del hogar de A`);
  } else if (deB.length > 0) {
    throw new Error(`B ya pertenece a OTRO hogar (${deB[0].household_id}) y no al de A. Este staging no lo construyó este script tal cual.`);
  } else {
    // El mismo camino que la app (web/src/app/family/actions.ts): A inserta la
    // invitación con el HASH del token; B la acepta con accept_invitation.
    const token = randomBytes(24).toString("base64url");
    const expira = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await restA.insertar("invitations", {
      household_id: hogarAB,
      email: cuentas.B.email,
      token_hash: sha256(token),
      role_code: "MEMBER",
      expires_at: expira,
    });
    const aceptado = await restB.rpc("accept_invitation", { p_token_hash: sha256(token), p_display_name: NOMBRES.personaB });
    if (aceptado !== hogarAB) throw new Error(`accept_invitation devolvió ${String(aceptado)} y se esperaba el hogar de A.`);
    bitacora(`B entró al hogar de A por invitación (accept_invitation)`);
  }

  // --- Dependiente sin cuenta, en el hogar de A -----------------------------
  const dependientes = await restA.leer(
    "household_members",
    `select=id,user_id&household_id=eq.${hogarAB}&display_name=eq.${encodeURIComponent(NOMBRES.dependiente)}`,
  );
  if (Array.isArray(dependientes) && dependientes.length > 0) {
    bitacora(`dependiente sin cuenta ya existía`);
  } else {
    await restA.insertar("household_members", { household_id: hogarAB, display_name: NOMBRES.dependiente });
    bitacora(`dependiente sin cuenta creado en el hogar de A`);
  }

  // --- AJENO: otro hogar -----------------------------------------------------
  const sesionAjeno = await auth.entrar(cuentas.AJENO.email, cuentas.AJENO.password);
  const restAjeno = clienteRest(urlProyecto, llaves.anon, sesionAjeno);
  const deAjeno = await membresiasDe(restAjeno, sesionAjeno.id);
  let hogarAjeno;
  if (deAjeno.some((m) => m.household_id === hogarAB)) {
    throw new Error("AJENO es integrante del hogar de A. Eso rompe lo que los E2E prueban; este staging no lo dejó este script.");
  }
  if (deAjeno.length === 0) {
    hogarAjeno = await restAjeno.rpc("create_household", { p_name: NOMBRES.hogarAjeno, p_display_name: NOMBRES.personaAjena });
    bitacora(`hogar ajeno creado por create_household`);
  } else {
    hogarAjeno = deAjeno[0].household_id;
    bitacora(`hogar ajeno ya existía`);
  }

  return { cuentas, hogarAB, hogarAjeno };
}

/** Comprobaciones finales. Devuelve la lista de fallas (vacía = humo OK). */
async function humo({ api, ref, libro, urlProyecto, llaves, correos, baseUrl }) {
  const fallas = [];
  const ok = (texto) => console.log(`  ✓ ${texto}`);

  const { entradas, presentes } = await testigosEnVivo(api, ref, libro);
  const falsos = entradas.filter(([clave]) => presentes.get(clave) !== true).map(([clave]) => clave);
  if (falsos.length > 0) fallas.push(`testigos en falso tras construir: ${falsos.join(", ")}`);
  else ok(`${entradas.length}/${entradas.length} testigos del libro verdaderos en staging`);

  // Mismo retrato que publicar-recetario.mjs: alimentos base y recetas publicadas.
  const retrato = await api.sql(
    ref,
    `select
      (select count(*) from public.ingredients where household_id is null) as alimentos,
      (select count(*) from public.meal_template_versions v
         join public.meal_templates t on t.id = v.template_id
        where t.household_id is null and v.status = 'PUBLISHED') as recetas`,
  );
  const alimentos = Number(retrato?.[0]?.alimentos);
  const recetas = Number(retrato?.[0]?.recetas);
  if (!Number.isFinite(recetas) || !Number.isFinite(alimentos)) fallas.push("no pude contar recetas y alimentos");
  else if (recetas < RECETAS_MINIMAS) fallas.push(`recetas publicadas: ${recetas}, se esperaban al menos ${RECETAS_MINIMAS}`);
  else ok(`${recetas} recetas publicadas · ${alimentos} alimentos base`);

  const buckets = await api.sql(ref, "select id from storage.buckets order by id");
  const ids = Array.isArray(buckets) ? buckets.map((b) => String(b.id)) : [];
  const sinBucket = BUCKETS_ESPERADOS.filter((b) => !ids.includes(b));
  if (sinBucket.length > 0) fallas.push(`faltan buckets: ${sinBucket.join(", ")}`);
  else ok(`buckets presentes: ${BUCKETS_ESPERADOS.join(", ")}`);

  const hogares = await api.sql(
    ref,
    `select h.name as hogar, m.display_name as persona, (m.user_id is not null) as con_cuenta, u.email
       from public.household_members m
       join public.households h on h.id = m.household_id
       left join auth.users u on u.id = m.user_id
      where m.is_active
      order by h.name, m.display_name`,
  );
  const filas = Array.isArray(hogares) ? hogares : [];
  const en = (hogar, email) => filas.some((f) => f.hogar === hogar && String(f.email ?? "").toLowerCase() === email.toLowerCase());
  if (!en(NOMBRES.hogarAB, correos.A.email)) fallas.push("A no está en el hogar de A y B");
  if (!en(NOMBRES.hogarAB, correos.B.email)) fallas.push("B no está en el hogar de A y B");
  if (!en(NOMBRES.hogarAjeno, correos.AJENO.email)) fallas.push("AJENO no está en el hogar ajeno");
  if (en(NOMBRES.hogarAB, correos.AJENO.email)) fallas.push("AJENO está en el hogar de A y B");
  if (!filas.some((f) => f.hogar === NOMBRES.hogarAB && f.persona === NOMBRES.dependiente && f.con_cuenta === false)) {
    fallas.push("falta el dependiente sin cuenta en el hogar de A y B");
  }
  if (fallas.length === 0) ok("A y B comparten hogar, AJENO vive en otro, y hay un dependiente sin cuenta");

  const auth = await api.configAuth(ref);
  const pendiente = planDeAuth(auth, configAuthDeseada(baseUrl));
  if (pendiente) fallas.push(`Auth de staging no quedó como se pidió: ${Object.keys(pendiente).join(", ")}`);
  else ok(`Auth: site_url=${auth.site_url}, mailer_autoconfirm=true (en producción va false)`);

  // Lo que Playwright necesita del archivo, comprobado SIN imprimir valores.
  const urlDelArchivo = variableE2E("E2E_SUPABASE_URL");
  if (urlDelArchivo !== urlProyecto) fallas.push(`E2E_SUPABASE_URL en web/.env.staging.local no es ${urlProyecto}`);
  const anonDelArchivo = variableE2E("E2E_SUPABASE_ANON_KEY");
  const serviceDelArchivo = variableE2E("E2E_SUPABASE_SERVICE_ROLE_KEY");
  if (!anonDelArchivo) fallas.push("falta E2E_SUPABASE_ANON_KEY en web/.env.staging.local (Supabase → Project Settings → API Keys)");
  else if (sha256(anonDelArchivo) !== sha256(llaves.anon)) fallas.push("E2E_SUPABASE_ANON_KEY no es la anon key de este proyecto");
  if (!serviceDelArchivo) fallas.push("falta E2E_SUPABASE_SERVICE_ROLE_KEY en web/.env.staging.local (misma pantalla; es secreta)");
  else if (sha256(serviceDelArchivo) !== sha256(llaves.serviceRole)) fallas.push("E2E_SUPABASE_SERVICE_ROLE_KEY no es la service_role de este proyecto");
  if (fallas.every((f) => !f.includes("E2E_SUPABASE"))) ok("web/.env.staging.local trae la URL y las dos llaves de ESTE proyecto");

  return fallas;
}

// ---------------------------------------------------------------------------
// El plan en seco, sin red
// ---------------------------------------------------------------------------

function imprimirPlanSinRed({ orden, refStaging, refProduccion, correos, baseUrl }) {
  const l = (t = "") => console.log(t);
  l("PLAN (en seco, sin tocar nada):");
  l("");
  l(`  Proyecto de staging: ${refStaging ?? "(sin definir: --ref, STAGING_PROJECT_REF o E2E_SUPABASE_URL)"}`);
  l(`  Proyecto de producción: ${refProduccion ?? "(no deducible de NEXT_PUBLIC_SUPABASE_URL)"} — nunca se toca`);
  l("");
  l(`  1. Migraciones (${orden.length}, en el orden del arnés; las aplica poner-al-dia.mjs --ref):`);
  for (const f of orden) l(`       ${f}`);
  l("     Contra un proyecto vivo el plan se recorta a lo que los testigos digan que falta.");
  l("");
  l("  2. Contenido: publicar-recetario.mjs --ref <staging> --aplicar (3 seeds con testigo, 452 recetas).");
  l("");
  l("  3. Cuentas (Auth Admin API, contraseñas desde web/.env.staging.local):");
  for (const quien of ["A", "B", "AJENO"]) {
    l(`       ${quien}: ${correos?.[quien]?.email ?? `(E2E_USER_${quien}_EMAIL sin definir)`}`);
  }
  l(`     A crea «${NOMBRES.hogarAB}» (create_household); B entra por invitación (accept_invitation);`);
  l(`     «${NOMBRES.dependiente}» sin cuenta en ese hogar; AJENO crea «${NOMBRES.hogarAjeno}».`);
  l("");
  l(`  4. Buckets que deben existir (los crean 0026 y 0045): ${BUCKETS_ESPERADOS.join(", ")}.`);
  l("");
  const deseada = configAuthDeseada(baseUrl ?? "http://localhost:3000");
  l("  5. Auth de staging (PATCH /v1/projects/<ref>/config/auth):");
  l(`       site_url = ${deseada.site_url}${baseUrl ? "" : "   (E2E_BASE_URL sin definir; se muestra el valor de ejemplo)"}`);
  l(`       uri_allow_list ⊇ ${deseada.uri_allow_list.join(", ")}`);
  l("       mailer_autoconfirm = true   (SOLO staging; en producción va false)");
  l("");
  l(`  6. Humo: testigos todos verdaderos, ≥ ${RECETAS_MINIMAS} recetas, cuentas y hogares como arriba,`);
  l("     buckets, Auth, y web/.env.staging.local con URL + anon + service_role de ESTE proyecto.");
  l("");
  l("  Variables que Playwright espera (nombres): " + VARIABLES_E2E.join(", "));
  l("");
  l("Nada se tocó.");
}

// ---------------------------------------------------------------------------
// principal
// ---------------------------------------------------------------------------

async function principal() {
  let opciones;
  try {
    opciones = extraerArgumentos(process.argv.slice(2));
  } catch (e) {
    salir(e instanceof Error ? e.message : String(e));
  }

  const refProduccion = refDeUrl(
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
      delArchivo(ENV_DESPLIEGUE, "NEXT_PUBLIC_SUPABASE_URL") ??
      delArchivo(ENV_LOCAL, "NEXT_PUBLIC_SUPABASE_URL"),
  );
  const refStaging =
    opciones.ref ??
    (process.env.STAGING_PROJECT_REF || null) ??
    refDeUrl(variableE2E("E2E_SUPABASE_URL"));

  const orden = ordenDelArnes(readFileSync(HARNESS, "utf8"));
  const baseUrl = variableE2E("E2E_BASE_URL");
  const correos = {};
  for (const quien of ["A", "B", "AJENO"]) {
    const email = variableE2E(`E2E_USER_${quien}_EMAIL`);
    const password = variableE2E(`E2E_USER_${quien}_PASSWORD`);
    if (email && password) correos[quien] = { email, password };
  }

  // LA GUARDA, antes de cualquier red y también en seco.
  const motivo = motivoParaNoTocar({ refStaging, refProduccion });
  if (motivo && !(opciones.enSeco && !refStaging)) salir(motivo);

  if (opciones.enSeco && !refStaging) {
    imprimirPlanSinRed({ orden, refStaging, refProduccion, correos, baseUrl });
    return 0;
  }

  const token = process.env.SUPABASE_ACCESS_TOKEN ?? delArchivo(ENV_DESPLIEGUE, "SUPABASE_ACCESS_TOKEN");
  if (!token) {
    salir(
      [
        "Falta el token de la Management API (SUPABASE_ACCESS_TOKEN en .env.deploy, en la raíz).",
        "Se crea en https://supabase.com/dashboard/account/tokens. Nunca en web/.env.local.",
      ].join(SALTO),
    );
  }
  const api = clienteManagement(token);
  const urlProyecto = `https://${refStaging}.supabase.co`;

  console.log(`Staging: ${refStaging}${opciones.enSeco ? "  (EN SECO: solo lectura)" : ""}`);
  console.log(`Producción: ${refProduccion ?? "(desconocido)"} — no se toca.`);

  let proyecto;
  try {
    proyecto = await api.proyecto(refStaging);
  } catch (e) {
    salir(`No pude leer el proyecto ${refStaging}: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(`Proyecto: «${proyecto?.name ?? "?"}» (${proyecto?.region ?? "?"}, estado ${proyecto?.status ?? "?"})`);

  // Datos que este script no creó = no se toca. Va antes que los testigos:
  // no hay nada que planear sobre un proyecto ajeno.
  const ajenos = hogaresAjenos(await nombresDeHogares(api, refStaging));
  if (ajenos.length > 0) {
    salir(
      [
        `El proyecto ${refStaging} tiene ${ajenos.length} hogar(es) que este script NO creó:`,
        ...ajenos.map((n) => `   ${n}`),
        "No es un staging construido acá. No se toca.",
      ].join(SALTO),
    );
  }

  const libro = libroDeProduccion();
  const { entradas, presentes } = await testigosEnVivo(api, refStaging, libro);
  const estados = clasificarCadena(orden, entradas, presentes);
  let plan;
  try {
    plan = planDeMigraciones(orden, estados, { desconocidasComoAusentes: opciones.desconocidasComoAusentes });
  } catch (e) {
    salir(e instanceof Error ? e.message : String(e));
  }

  console.log("");
  console.log(`Migraciones: ${orden.length - plan.plan.length} puestas, ${plan.plan.length} por aplicar.`);
  for (const n of plan.notas) console.log(`  · ${n}`);
  for (const f of plan.plan) console.log(`   ${f}`);

  const auth = await api.configAuth(refStaging);
  const cambiosAuth = baseUrl ? planDeAuth(auth, configAuthDeseada(baseUrl)) : null;

  if (opciones.enSeco) {
    console.log("");
    console.log(`Auth: ${cambiosAuth ? `cambiaría ${Object.keys(cambiosAuth).join(", ")}` : baseUrl ? "ya está como se pide" : "E2E_BASE_URL sin definir; no se puede planear"}`);
    console.log("Contenido y cuentas: se comprueban al construir (publicar-recetario.mjs --ref tiene su propio modo de revisión).");
    console.log("");
    console.log("EN SECO: no se escribió nada.");
    return 0;
  }

  const faltan = VARIABLES_PARA_CONSTRUIR.filter((v) => !variableE2E(v));
  if (faltan.length > 0) {
    salir(
      [
        "Faltan variables en web/.env.staging.local (o en el entorno):",
        ...faltan.map((v) => `   ${v}`),
        "Copia web/.env.staging.example y llénalo. Ver docs/deployment/staging.md.",
      ].join(SALTO),
    );
  }

  // 1. Migraciones, por el dueño del orden.
  if (plan.plan.length > 0) {
    const codigo = correrScript(PONER_AL_DIA, ["--ref", refStaging, "--aplicar", ...plan.plan]);
    if (codigo !== 0) salir(`poner-al-dia.mjs terminó con ${codigo}. Staging quedó a medio migrar: arregla eso antes de seguir.`);
  }

  // 2. Contenido.
  {
    const codigo = correrScript(PUBLICAR_RECETARIO, ["--ref", refStaging, "--aplicar"]);
    if (codigo !== 0) salir(`publicar-recetario.mjs terminó con ${codigo}.`);
  }

  // 3. Llaves (nunca se imprimen) y cuentas.
  const llaves = await api.llaves(refStaging);
  console.log("");
  console.log("Cuentas y hogares:");
  await asegurarHogaresYCuentas({
    api,
    ref: refStaging,
    urlProyecto,
    llaves,
    correos,
    bitacora: (t) => console.log(`  · ${t}`),
  });

  // 4. Auth.
  if (cambiosAuth) {
    await api.patchConfigAuth(refStaging, cambiosAuth);
    console.log(`Auth actualizada: ${Object.keys(cambiosAuth).join(", ")}.`);
  } else {
    console.log("Auth ya estaba como se pide.");
  }

  // 5. Humo.
  console.log("");
  console.log("Humo:");
  const fallas = await humo({ api, ref: refStaging, libro, urlProyecto, llaves, correos, baseUrl });
  if (fallas.length > 0) {
    salir(["", "STAGING CON PROBLEMAS:", ...fallas.map((f) => `  ✗ ${f}`), "", "Los E2E no pueden correr hasta arreglar lo de arriba."].join(SALTO));
  }
  console.log("");
  console.log("STAGING LISTO. Para correr los E2E: cd web && npm run e2e:staging (con web/.env.staging.local cargado).");
  return 0;
}

const esEjecucionDirecta =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (esEjecucionDirecta) {
  try {
    process.exitCode = await principal();
  } catch (e) {
    if (e instanceof SalidaControlada) {
      process.exitCode = e.codigo;
    } else {
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exitCode = 1;
    }
  }
}
