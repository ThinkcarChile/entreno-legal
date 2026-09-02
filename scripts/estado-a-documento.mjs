#!/usr/bin/env node
/**
 * Vuelca el estado de producción del LIBRO al documento de despliegue.
 *
 *   node scripts/estado-a-documento.mjs              (muestra; no escribe)
 *   node scripts/estado-a-documento.mjs --escribir
 *
 * POR QUÉ EXISTE: `docs/deployment/pending-supabase-migrations.md` decía, a
 * mano, hasta dónde estaba aplicada la cadena. Ese dato ya tenía otro dueño
 * —`supabase/estado-produccion.json`, donde cada migración declara un testigo
 * que se le pregunta A LA BASE— y los dos discreparon, como discrepan siempre
 * dos dueños del mismo dato: el documento seguía anunciando la 0036 y la 0038
 * como pendientes cuando producción ya las tenía puestas hacía días.
 *
 * Una lista de "qué falta aplicar" equivocada no es un detalle de documentación:
 * es la lista con la que alguien decide qué correr contra una base con datos de
 * una familia.
 *
 * Lo que el documento SÍ sigue teniendo de suyo es la prosa: qué hace cada
 * migración, con qué checksum se revisó y qué se verificó en vivo. Eso no se
 * toca. Lo único que pasa a ser derivado es el ESTADO, que es justamente lo que
 * cambia solo cada vez que se aplica algo.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIBRO = path.join(RAIZ, "supabase", "estado-produccion.json");
const DOC = path.join(RAIZ, "docs", "deployment", "pending-supabase-migrations.md");

export const INICIO = "<!-- ESTADO:INICIO — generado, no editar a mano -->";
export const FIN = "<!-- ESTADO:FIN -->";

/** El bloque, tal como debe quedar en el documento. */
export function bloqueDesdeLibro(libro) {
  const entradas = Object.entries(libro.migraciones ?? {});
  const aplicadas = entradas.filter(([, m]) => m.estado === "APLICADA").map(([f]) => f);
  const pendientes = entradas.filter(([, m]) => m.estado === "PENDIENTE").map(([f]) => f);

  const l = [
    INICIO,
    "",
    `**Proyecto:** \`${libro.proyecto}\` · **${aplicadas.length} aplicadas** · ` +
      `**${pendientes.length} pendientes**`,
    "",
    `Método: \`${libro.metodo}\` · verificado el ${libro.verificado_el} · ` +
      `vale hasta el ${libro.caduca_el}.`,
    "",
    "Esto NO se escribe a mano: sale de `supabase/estado-produccion.json`, donde cada",
    "migración declara un testigo —una expresión SQL falsa antes de aplicarla y verdadera",
    "después— que se le pregunta a la base de verdad. Para actualizarlo:",
    "",
    "```bash",
    "node scripts/verificar-estado-produccion.mjs --escribir",
    "node scripts/estado-a-documento.mjs --escribir",
    "```",
    "",
  ];

  if (pendientes.length === 0) {
    l.push("**No queda ninguna pendiente:** producción tiene la cadena completa.", "");
  } else {
    l.push("**Pendientes de aplicar, en el orden en que van:**", "");
    for (const f of pendientes) l.push(`- \`${f}\``);
    l.push(
      "",
      "```bash",
      "node scripts/poner-al-dia.mjs --pendientes            # muestra el plan, no toca nada",
      "node scripts/poner-al-dia.mjs --pendientes --aplicar",
      "```",
      "",
    );
  }

  l.push(
    `<sub>Aplicadas: ${aplicadas.map((f) => f.slice(0, 4)).join(", ")}</sub>`,
    "",
    FIN,
  );
  return l.join("\n");
}

/**
 * Mete el bloque en el documento. Si ya hay uno, lo REEMPLAZA; si no, lo pone
 * justo debajo del encabezado de estado.
 *
 * Devuelve el texto nuevo, o lanza si no encuentra dónde ponerlo: escribir el
 * bloque en un lugar cualquiera de un documento de despliegue es peor que no
 * escribirlo.
 */
export function conBloque(doc, bloqueCrudo) {
  // EL BLOQUE ADOPTA EL FINAL DE LINEA DEL DOCUMENTO.
  //
  // El documento esta en CRLF y el bloque se arma con saltos simples. Sin esto
  // quedaban mezclados y, peor, cualquier editor que normalice al guardar dejaba
  // el guardian en rojo diciendo "el documento quedo atras" cuando no habia
  // cambiado nada de fondo. Un guardian que acusa en falso se termina
  // silenciando, y ese precio es mucho mas alto que estas dos lineas.
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const crlf = doc.includes(CR + LF);
  const nl = crlf ? CR + LF : LF;
  const bloque = crlf ? bloqueCrudo.split(LF).join(CR + LF) : bloqueCrudo;

  const i = doc.indexOf(INICIO);
  if (i !== -1) {
    const j = doc.indexOf(FIN, i);
    if (j === -1) throw new Error("El documento abre el bloque de estado y nunca lo cierra.");
    return doc.slice(0, i) + bloque + doc.slice(j + FIN.length);
  }
  const encabezado = "## Estado remoto conocido";
  const k = doc.indexOf(encabezado);
  if (k === -1) {
    throw new Error(
      `No encuentro "${encabezado}" en el documento: no sé dónde va el bloque y no lo invento.`,
    );
  }
  const corte = k + encabezado.length;
  return doc.slice(0, corte) + nl + nl + bloque + nl + doc.slice(corte);
}

// --------------------------------------------------------------------- inicio
// En Windows `file://` + la ruta NO da la misma cadena que `import.meta.url`
// (que trae tres barras y la unidad): se compara con la conversion oficial.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync(LIBRO) || !existsSync(DOC)) {
    console.error("\nFalta el libro o el documento.\n");
    process.exit(1);
  }
  const bloque = bloqueDesdeLibro(JSON.parse(readFileSync(LIBRO, "utf8")));
  const doc = readFileSync(DOC, "utf8");
  const nuevo = conBloque(doc, bloque);

  if (!process.argv.includes("--escribir")) {
    console.log("\n" + bloque + "\n");
    console.log(
      nuevo === doc
        ? "El documento ya está al día.\n"
        : "El documento NO está al día. Para actualizarlo:\n\n   node scripts/estado-a-documento.mjs --escribir\n",
    );
    process.exit(0);
  }
  writeFileSync(DOC, nuevo, "utf8");
  console.log(nuevo === doc ? "\nYa estaba al día.\n" : "\nDocumento actualizado.\n");
}
