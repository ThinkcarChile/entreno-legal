#!/usr/bin/env node
/**
 * Restaura un respaldo y COMPRUEBA que quedó bien.
 *
 * Este archivo es SÓLO la línea de comandos: argumentos, destinos, mensajes y
 * código de salida. El motor —el que borra, inserta, verifica hashes y cuenta
 * huérfanos— vive en `respaldo-nucleo.mjs`, que no sabe nada de argv ni llama a
 * `process.exit`. Se separaron por un motivo concreto: durante una ronda entera
 * el camino que de verdad rescata a la familia (`--destino supabase`) no
 * ejecutó una sola escritura en ninguna parte, porque estaba enredado con el
 * `process.argv` y no había forma de correrlo desde una prueba. Hoy sí la hay:
 * `web/src/integration/respaldo-camino-real.test.ts` corre ESE mismo motor, en
 * modo real y escribiendo de verdad, contra un Postgres desechable.
 *
 *   node scripts/respaldo-restaurar.mjs ultimo
 *   node scripts/respaldo-restaurar.mjs /ruta/al/respaldo.ndjson
 *   node scripts/respaldo-restaurar.mjs ultimo --destino supabase --en-seco
 *   node scripts/respaldo-restaurar.mjs ultimo --destino supabase --si-estoy-seguro
 *
 * Los tres modos, y qué prueba cada uno:
 *
 *   ENSAYO (por defecto, `--destino pglite`)
 *     Restaura en un Postgres limpio y desechable con el esquema que tenía la
 *     base cuando se sacó el respaldo. Prueba que el ARCHIVO sirve: que vuelve
 *     completo, idéntico y sin huérfanos. NO prueba nada de producción.
 *
 *   ENSAYO DEL CAMINO REAL (`--destino supabase --en-seco`)
 *     Le pregunta a producción todo lo que la restauración de verdad necesita
 *     saber —su esquema, si permite apagar las llaves foráneas, qué cuentas
 *     tiene— y genera las sentencias de carga SIN ejecutarlas. Después corre
 *     esas MISMAS sentencias contra un Postgres desechable sembrado con los ids
 *     de cuenta de producción, y verifica ahí. Es el único ensayo que ejercita
 *     el reenlace de cuentas con los ids de verdad. No escribe una fila en
 *     producción.
 *
 *   DE VERDAD (`--destino supabase --si-estoy-seguro`)
 *     BORRA E INSERTA sobre la base real. Si el destino ya tiene datos, además
 *     exige `--sobrescribir`.
 *
 * Cómo restaura, y por qué así:
 *
 *   Las llaves foráneas de este esquema tienen un ciclo real —`meal_templates`
 *   apunta a `meal_template_versions` y `meal_template_versions` apunta de
 *   vuelta a `meal_templates`—, así que NO existe un orden de inserción que
 *   funcione. Se restaura como lo hace `pg_restore`: con
 *   `session_replication_role = replica`, que apaga los disparadores de
 *   integridad referencial mientras entran los datos. Los índices únicos, las
 *   llaves primarias y los CHECK siguen activos, esos no son disparadores.
 *
 *   Apagar las FK durante la carga obliga a comprobarlas DESPUÉS a mano, y eso
 *   es exactamente lo que hace el paso «huérfanos».
 */

import path from "node:path";

import {
  SALTO,
  baseDePruebas,
  credenciales,
  dirRespaldosPorDefecto,
  ejecutorPglite,
  ejecutorSupabase,
  ident,
  leerRespaldo,
  literal,
  morir,
  redactar,
  respaldoMasReciente,
} from "./respaldo-lib.mjs";
import { AbortoDeRestauracion, ejecutorEnSeco, restaurar } from "./respaldo-nucleo.mjs";

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const tieneBandera = (n) => args.includes(n);
function valorDe(n) {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] ?? null : null;
}

const posicional = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--destino");
const DESTINO = valorDe("--destino") ?? "pglite";
const SEGURO = tieneBandera("--si-estoy-seguro");
const SOBRESCRIBIR = tieneBandera("--sobrescribir");
const EN_SECO = tieneBandera("--en-seco");

if (!["pglite", "supabase"].includes(DESTINO)) {
  morir(`--destino sólo acepta \`pglite\` (ensayo) o \`supabase\` (de verdad). Llegó: ${DESTINO}`);
}
if (!posicional) {
  morir(
    [
      "Uso: node scripts/respaldo-restaurar.mjs <archivo.ndjson|ultimo> [--destino pglite|supabase]",
      "",
      "  ultimo     toma el respaldo más nuevo de " + dirRespaldosPorDefecto(),
      "  --en-seco  con --destino supabase: ensaya el camino real SIN escribir en producción",
    ].join(SALTO),
  );
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

/**
 * Se sale por `process.exitCode`, NUNCA por `process.exit`.
 *
 * `process.exit()` con un socket de `fetch` todavía abierto revienta en Windows
 * con `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` y devuelve 127 en
 * vez del código que uno pidió — o sea, el proceso miente justo en el camino de
 * error. Ya mordió en `aplicar-migracion.mjs` y en
 * `verificar-estado-produccion.mjs`; acá no se repite.
 */
const porCerrar = [];

async function cerrarTodo() {
  for (const cerrar of porCerrar.reverse()) {
    try {
      await cerrar();
    } catch {
      /* si no se puede cerrar la base desechable, el código de salida manda igual */
    }
  }
}

function abortar(mensaje) {
  console.error("");
  console.error(redactar(mensaje));
  console.error("");
  return 1;
}

// ---------------------------------------------------------------------------
// El programa
// ---------------------------------------------------------------------------

/** Base desechable con las migraciones que tenía producción cuando se respaldó. */
async function baseAlNivelDelRespaldo(cabecera, mostrar) {
  const base = await baseDePruebas({
    tablasRespaldo: cabecera.esquema.tablas,
    refRespaldo: cabecera.proyecto_ref,
  });
  porCerrar.push(() => base.db.close());
  if (mostrar) {
    console.log(`Base de ensayo: ${base.aplicadas.length} migraciones, hasta ${base.nivel ?? "(ninguna)"}.`);
    console.log(`  Nivel elegido por: ${base.fuente}.`);
    for (const nota of base.notas) console.log(`  · ${nota}`);
    if (base.sobrantes.length > 0) {
      console.log(`  Quedan fuera del ensayo (son posteriores al respaldo): ${base.sobrantes.join(", ")}`);
      console.log("  En una restauración real van DESPUÉS de cargar los datos, no antes.");
    }
  }
  return base;
}

/**
 * Corre las sentencias que se generaron PARA PRODUCCIÓN contra un Postgres
 * desechable, y verifica ahí.
 *
 * Generarlas y no correrlas en ninguna parte prueba la mitad de la mitad. Acá
 * se levanta una base con el esquema del respaldo, se le siembran los ids de
 * cuenta que tiene producción —los reenlazados, que es justo la parte que sólo
 * existe en este camino— y se corre la restauración real completa.
 */
async function espejarCaminoReal(respaldo, cuentasDestino) {
  const sinId = cuentasDestino.filter((c) => c.id === null);
  if (sinId.length > 0) {
    throw new AbortoDeRestauracion(
      `${sinId.length} cuenta(s) del respaldo quedaron sin id en el destino. No se siembra nada inventado.`,
    );
  }

  const espejo = await baseAlNivelDelRespaldo(respaldo.cabecera, false);
  if (cuentasDestino.length > 0) {
    const filas = cuentasDestino
      .map(
        (c) =>
          `(${literal(c.id)}::uuid, ${c.email === null ? "null" : literal(c.email)}, ` +
          `${c.created_at === null ? "null" : `${literal(c.created_at)}::timestamptz`})`,
      )
      .join(", ");
    await espejo.db.exec(
      `insert into auth.users (${ident("id")}, ${ident("email")}, ${ident("created_at")}) values ${filas};`,
    );
  }

  return restaurar({
    respaldo,
    ejecutor: ejecutorPglite(espejo.db, "Postgres desechable (espejo del camino real)"),
    modo: "real",
    base: espejo,
    seco: false,
    // Las pendientes ya las ejercita el ensayo normal; acá interesa el tramo de
    // carga y verificación, no volver a correr cuarenta migraciones.
    aplicarPendientes: false,
    log: (t) => console.log(`  ${t}`),
  });
}

async function principal() {
  // --- 1. Abrir el archivo (y negarse si está truncado o alterado) ---------
  let ruta = posicional;
  if (posicional === "ultimo") {
    ruta = respaldoMasReciente(dirRespaldosPorDefecto());
    if (!ruta) {
      return abortar(
        `No hay ningún .ndjson en ${dirRespaldosPorDefecto()}. Corre primero node scripts/respaldo.mjs`,
      );
    }
  }

  let respaldo;
  try {
    respaldo = leerRespaldo(path.resolve(ruta));
  } catch (e) {
    return abortar(e instanceof Error ? e.message : String(e));
  }

  const { cabecera, cierre } = respaldo;

  console.log(`Respaldo: ${path.basename(respaldo.ruta)}`);
  console.log(`  Generado: ${cabecera.generado_en} · proyecto ${cabecera.proyecto_ref}`);
  console.log(`  ${cierre.tablas} tablas · ${cierre.filas} filas · hash verificado`);
  if (!cabecera.snapshot_coherente) {
    console.log("  AVISO: se sacó con --por-tabla. NO es una foto coherente entre tablas.");
  }
  console.log(`  Destino: ${DESTINO}${EN_SECO ? " (EN SECO: no escribe)" : ""}`);
  console.log("");

  // --- 2. Levantar el destino ----------------------------------------------
  let ejecutor;
  let base = null;
  const modo = DESTINO === "pglite" ? "ensayo" : "real";

  if (modo === "ensayo") {
    try {
      base = await baseAlNivelDelRespaldo(cabecera, true);
    } catch (e) {
      return abortar(e instanceof Error ? e.message : String(e));
    }
    ejecutor = ejecutorPglite(base.db);
  } else {
    let creds;
    try {
      creds = credenciales();
    } catch (e) {
      return abortar(e instanceof Error ? e.message : String(e));
    }
    if (creds.ref !== cabecera.proyecto_ref) {
      console.log(`AVISO: el respaldo salió del proyecto ${cabecera.proyecto_ref} y el destino es ${creds.ref}.`);
    }
    if (!SEGURO && !EN_SECO) {
      return abortar(
        [
          `--destino supabase BORRA E INSERTA en el proyecto ${creds.ref}. Eso es irreversible.`,
          "",
          "Antes de correrlo:",
          "  1. Saca un respaldo del estado ACTUAL: node scripts/respaldo.mjs",
          `  2. Ensaya el archivo: node scripts/respaldo-restaurar.mjs ${path.basename(respaldo.ruta)}`,
          "  3. Ensaya el CAMINO REAL contra producción sin escribirle nada:",
          `       node scripts/respaldo-restaurar.mjs ${path.basename(respaldo.ruta)} --destino supabase --en-seco`,
          "  4. Recién ahí agrega --si-estoy-seguro",
        ].join(SALTO),
      );
    }
    const real = ejecutorSupabase(creds);
    ejecutor = EN_SECO ? ejecutorEnSeco(real) : real;
    console.log(`Destino real: ${ejecutor.nombre}`);
  }

  // La restauración de verdad no pisa datos vivos sin que alguien lo pida por
  // escrito. El motor llama a esto en el único punto donde todavía se puede
  // parar: después de contar, antes del primer `delete`.
  function guardaDeSobrescritura(conDatos) {
    if (modo !== "real" || EN_SECO || SOBRESCRIBIR || conDatos.length === 0) return;
    throw new AbortoDeRestauracion(
      [
        `El proyecto destino YA TIENE DATOS en ${conDatos.length} tabla(s):`,
        ...conDatos.slice(0, 10).map(([t, n]) => `  - ${t}: ${n} fila(s)`),
        conDatos.length > 10 ? `  … y ${conDatos.length - 10} más` : "",
        "",
        "Restaurar los BORRA y los reemplaza por los del respaldo.",
        "Si eso es exactamente lo que quieres, agrega --sobrescribir.",
      ]
        .filter(Boolean)
        .join(SALTO),
    );
  }

  // --- 3. Restaurar ---------------------------------------------------------
  let resultado;
  try {
    resultado = await restaurar({
      respaldo,
      ejecutor,
      modo,
      base,
      seco: EN_SECO,
      aplicarPendientes: !tieneBandera("--sin-migraciones-pendientes"),
      alDetectarDatos: guardaDeSobrescritura,
    });
  } catch (e) {
    if (e instanceof AbortoDeRestauracion) return abortar(e.message);
    return abortar(`Falló la restauración: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }

  // En un destino recién migrado no todo está vacío: varias migraciones siembran
  // catálogo (biomarker_definitions, equipment_capabilities, storage_safety_rules).
  // El respaldo manda: se borra y se pone lo del archivo.
  if (modo === "ensayo" && resultado.conDatos.length > 0) {
    const sembradas = resultado.conDatos.reduce((a, [, n]) => a + n, 0);
    console.log(`  (el destino traía ${sembradas} filas sembradas por las migraciones; el respaldo las reemplaza)`);
  }

  // --- 4. El espejo del camino real ----------------------------------------
  let espejado = null;
  if (EN_SECO && modo === "real") {
    console.log("");
    console.log("Corriendo esas mismas sentencias contra un Postgres desechable…");
    try {
      espejado = await espejarCaminoReal(respaldo, resultado.cuentasDestino);
      resultado.problemas.push(...espejado.problemas);
      resultado.avisos.push(...espejado.avisos);
    } catch (e) {
      resultado.problemas.push(
        `El espejo del camino real falló: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // --- 5. Veredicto ---------------------------------------------------------
  console.log("");
  if (resultado.avisos.length > 0) {
    console.log("Avisos (no invalidan la restauración, pero léelos):");
    for (const a of resultado.avisos) console.log(`  · ${redactar(a)}`);
    console.log("");
  }
  if (resultado.hallazgos.length > 0) {
    console.log("HALLAZGO (no es del respaldo, pero hay que arreglarlo):");
    for (const h of resultado.hallazgos) console.log(`  ! ${redactar(h)}`);
    console.log("");
  }

  if (resultado.problemas.length > 0) {
    console.error("RESTAURACIÓN CON PROBLEMAS:");
    for (const p of resultado.problemas) console.error(`  ✗ ${redactar(p)}`);
    console.error("");
    console.error(
      modo === "ensayo" || EN_SECO
        ? "Este respaldo NO está probado. No confíes en él hasta arreglar lo de arriba."
        : "La base real quedó en un estado que no calza con el respaldo. Revísalo AHORA.",
    );
    return 1;
  }

  if (EN_SECO) {
    // Sin espejo no hay ensayo del camino real, y un «OK» que resuma «0/0
    // tablas» sería un verde que no significa nada. Si esto ocurriera, el
    // bloque de problemas de arriba ya habría cortado; queda igual porque el
    // que anuncia el OK no puede tener una rama donde no sabe qué anuncia.
    if (!espejado) return abortar("El espejo del camino real no llegó a correr: no hay nada que declarar OK.");
    console.log(
      `ENSAYO DEL CAMINO REAL OK: producción recibe este respaldo, deja apagar las llaves ` +
        `foráneas y tiene todas las cuentas; las sentencias generadas para ella cargan y vuelven ` +
        `idénticas en el espejo (${espejado.tablasOk}/${espejado.plan.length} tablas, ` +
        `${espejado.huerfanos} huérfanos). NO se escribió nada en producción.`,
    );
    console.log("");
    console.log("Lo que este ensayo NO cubre: que la base viva aguante la escritura de verdad");
    console.log("—cuota de disco, tiempo de la Management API, algún disparador que sólo esté");
    console.log("allá—. Eso sólo lo sabe la corrida con --si-estoy-seguro.");
    return 0;
  }

  if (modo === "ensayo") {
    console.log(
      `ENSAYO OK: el respaldo se restaura completo y vuelve idéntico (${cierre.filas} filas, ${resultado.plan.length} tablas).`,
    );
    return 0;
  }

  console.log(`RESTAURACIÓN OK: ${cierre.filas} filas en ${resultado.plan.length} tablas, sin huérfanos.`);
  console.log("");
  console.log("Falta a mano (no lo hace este script):");
  console.log("  - Subir de nuevo los archivos del bucket medical-documents.");
  console.log("  - Comprobar en la app que cada integrante ve su ficha y NADA de la ajena.");
  return 0;
}

process.exitCode = await principal();
await cerrarTodo();
