import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GATE FINAL §5 — CONTRATO: NINGUNA escritura descarta su resultado.
 *
 * Regla que Sprint 11 hereda: una escritura fallida debe propagarse, mostrar
 * error y no presentar éxito. El patrón `await supabase.from(...).insert(...)`
 * SIN capturar `{ error }` convierte cualquier fallo (RLS, constraint, red) en
 * un "guardado" falso — fue exactamente el defecto de `saveMealGoals`, donde 4
 * escrituras seguidas tiraban su resultado y la pantalla decía "actualizado".
 *
 * Este test recorre TODAS las server actions y falla si aparece una sentencia
 * `await <cliente>.…(insert|update|upsert|delete|rpc)(…)` cuyo resultado se
 * descarta (no se asigna a nada). No hay lista de excepciones: si algún día
 * un caso legítimo necesita descartar, se anota acá con su porqué.
 */

const APP = path.resolve(__dirname, "../app");

function archivosDeAcciones(raiz: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(raiz)) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) out.push(...archivosDeAcciones(ruta));
    else if (/(actions|nutrition-actions|profile-publish)\.ts$/.test(nombre)) out.push(ruta);
  }
  return out;
}

describe("§5 — las escrituras nunca tragan su error", () => {
  it("ninguna server action descarta el resultado de una escritura", () => {
    const ofensas: string[] = [];
    for (const archivo of archivosDeAcciones(APP)) {
      const fuente = readFileSync(archivo, "utf8");
      const rel = path.relative(APP, archivo);
      // Sentencia que EMPIEZA con `await` (no `const … = await`) sobre un
      // cliente de datos, desde ahí hasta el `;` que la cierra.
      for (const m of fuente.matchAll(/^[ \t]*await\s+((?:ctx\.)?supabase|db)\b/gm)) {
        const inicio = m.index!;
        const fin = fuente.indexOf(";", inicio);
        if (fin === -1) continue;
        const sentencia = fuente.slice(inicio, fin);
        if (/\.(insert|update|upsert|delete|rpc)\(/.test(sentencia)) {
          const linea = fuente.slice(0, inicio).split("\n").length;
          ofensas.push(`${rel}:${linea} · ${sentencia.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
    }
    expect(ofensas).toEqual([]);
  });
});
