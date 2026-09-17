/**
 * La máquina de estados de la asignación está escrita dos veces a propósito:
 *
 *   · `src/lib/domain/state-machines.ts` → `assignmentTransitions`, que es lo
 *     que consulta la interfaz para decidir qué botón ofrecer;
 *   · `app_private.guard_assignment_transitions()` → el disparador que la
 *     impone en la base, porque el usuario tiene UPDATE sobre `status` y la
 *     interfaz no es una frontera de seguridad.
 *
 * Dos copias solo sirven si no se separan. Esto las compara y falla si difieren.
 * Lo llama `npm run db:contract`, que es el sitio donde ya se contrasta lo que
 * la aplicación cree con lo que la base tiene.
 *
 * Uso: node scripts/compare-assignment-transitions.mjs "<cuerpo de la función>"
 * El cuerpo llega por argumento para no depender de psql desde aquí.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Lee el mapa de TypeScript sin ejecutarlo. */
function desdeTypeScript() {
  const src = readFileSync(resolve(raiz, "src/lib/domain/state-machines.ts"), "utf8");
  const inicio = src.indexOf("export const assignmentTransitions");
  if (inicio === -1) throw new Error("no se encontró assignmentTransitions");
  const abre = src.indexOf("{", inicio);
  const cierra = src.indexOf("};", abre);
  const cuerpo = src.slice(abre + 1, cierra);

  const mapa = new Map();
  for (const linea of cuerpo.split("\n")) {
    const m = /^\s*([A-Z_]+)\s*:\s*\[([^\]]*)\]/.exec(linea);
    if (!m) continue;
    const destinos = m[2]
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    mapa.set(m[1], destinos.sort());
  }
  return mapa;
}

/** Lee el mismo mapa del cuerpo de la función de PostgreSQL. */
function desdeSql(cuerpo) {
  const mapa = new Map();
  const re = /when\s+'([A-Z_]+)'\s*then\s+array\[([^\]]*)\]/gi;
  let m;
  while ((m = re.exec(cuerpo)) !== null) {
    const destinos = m[2]
      .split(",")
      .map((x) => x.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);
    mapa.set(m[1], destinos.sort());
  }
  // Los estados finales están en el `else array[]::text[]`, implícitos.
  return mapa;
}

const cuerpoSql = process.argv[2] ?? "";
if (!cuerpoSql.trim()) {
  console.error("FALLO: no se recibió el cuerpo de guard_assignment_transitions");
  process.exit(1);
}

const ts = desdeTypeScript();
const sql = desdeSql(cuerpoSql);

let fallos = 0;
for (const [estado, destinos] of ts) {
  const enSql = sql.get(estado) ?? [];
  const mismo = destinos.length === enSql.length && destinos.every((d, i) => d === enSql[i]);
  if (!mismo) {
    // Un estado final (sin salidas en TypeScript) no necesita rama en el SQL:
    // el `else` lo deja sin destinos permitidos, que es lo mismo.
    if (destinos.length === 0 && enSql.length === 0) continue;
    console.error(
      `FALLO: la transición de ${estado} no coincide. ` +
        `TypeScript: [${destinos.join(", ")}] · base: [${enSql.join(", ")}]`,
    );
    fallos += 1;
  }
}
for (const estado of sql.keys()) {
  if (!ts.has(estado)) {
    console.error(`FALLO: la base permite salir de ${estado} y TypeScript no conoce ese estado`);
    fallos += 1;
  }
}

if (fallos === 0) {
  console.log(`✓ Las ${ts.size} transiciones de la asignación coinciden en TypeScript y en la base`);
}
process.exit(fallos === 0 ? 0 : 1);
