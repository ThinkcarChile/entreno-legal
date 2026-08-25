import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { levantarBase, type Harness } from "./harness";

/**
 * CONTRATO CARGADOR ↔ BASE (Integration Gate §35, obligatorio).
 *
 * El bug de `weight_basis` (demo viva del Sprint 10) tumbó /pantry contra el
 * Supabase real: el schema Zod exigía una columna que el `.select()` no pedía.
 * Ningún test lo vio porque los tests arman el input del motor a mano.
 *
 * Este archivo audita AUTOMÁTICAMENTE todos los cargadores:
 *
 *  1. Toda columna que un `.select()` pide DEBE existir en la tabla/vista real
 *     (se ejecuta contra PostgreSQL de verdad, con la cadena de migraciones).
 *  2. Toda columna que un schema Zod exige DEBE estar pedida por algún
 *     `.select()` del mismo archivo (o derivada con `columnsOf`).
 *
 * Lo que la lectura estática no alcanza (selects armados dinámicamente) se
 * DECLARA en la salida del test en vez de dar un verde silencioso.
 */

const APP = path.resolve(__dirname, "../app");

interface Consulta {
  archivo: string;
  tabla: string;
  columnas: string[];
  embeds: { tabla: string; columnas: string[] }[];
}

/**
 * `.from("x").select(…)` inmediato, con el argumento COMPLETO: soporta
 * literales simples, template strings y concatenaciones `"a, b" + "c, d"`.
 * Si hay interpolación, la consulta se declara no verificable.
 */
function extraerConsultas(archivo: string, fuente: string): Consulta[] {
  const consultas: Consulta[] = [];
  const re = /\.from\(\s*"([a-z_]+)"\s*\)\s*\.select\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fuente)) !== null) {
    const tabla = m[1]!;
    // Recorrer hasta el paréntesis que cierra el select (balanceado).
    let i = m.index + m[0].length;
    let nivel = 1;
    const inicio = i;
    while (i < fuente.length && nivel > 0) {
      const ch = fuente[i]!;
      if (ch === "(") nivel++;
      else if (ch === ")") nivel--;
      i++;
    }
    const argumento = fuente.slice(inicio, i - 1);
    if (argumento.includes("${")) continue; // interpolado: no verificable
    const literales = [...argumento.matchAll(/(["'`])([\s\S]*?)\1/g)].map((x) => x[2]!);
    if (literales.length === 0) continue;
    const cuerpo = literales.join("").replace(/\s+/g, " ").trim();
    if (cuerpo === "*" || cuerpo.length === 0) continue;

    const embeds: { tabla: string; columnas: string[] }[] = [];
    let sinEmbeds = cuerpo;
    let previo = "";
    while (sinEmbeds !== previo) {
      previo = sinEmbeds;
      sinEmbeds = sinEmbeds.replace(
        /([a-z_]+)\s*(?:![a-z_]+)?\s*\(([^()]*)\)/g,
        (_todo, nombre: string, cols: string) => {
          embeds.push({
            tabla: nombre.trim(),
            columnas: cols
              .split(",")
              .map((c) => c.trim().replace(/![a-z_]+/g, "").trim())
              .filter((c) => c.length > 0),
          });
          return "";
        },
      );
    }
    const columnas = sinEmbeds
      .split(",")
      .map((c) => c.trim().replace(/![a-z_]+/g, "").trim())
      .filter((c) => c.length > 0 && !c.includes("(") && !c.includes(")"));
    consultas.push({ archivo, tabla, columnas, embeds });
  }
  return consultas;
}

/** Claves OBLIGATORIAS y planas de cada `const xRow = z.object({...})`. */
function extraerSchemas(fuente: string): { nombre: string; requeridas: string[] }[] {
  const out: { nombre: string; requeridas: string[] }[] = [];
  const re = /const\s+(\w*[Rr]ow\w*)\s*=\s*z\s*\.object\(\{([\s\S]*?)\n\}\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fuente)) !== null) {
    const nombre = m[1]!;
    const lineas = m[2]!.split("\n");
    const requeridas: string[] = [];
    for (let i = 0; i < lineas.length; i++) {
      const km = lineas[i]!.match(/^\s{2}([a-z_][a-z0-9_]*)\s*:/i);
      if (!km) continue;
      let decl = lineas[i]!;
      for (let j = i + 1; j < lineas.length && !/^\s{2}[a-z_][a-z0-9_]*\s*:/i.test(lineas[j]!); j++) {
        decl += "\n" + lineas[j]!;
      }
      // Opcionales y embeds (uniones/arrays anidados) no son columnas planas.
      if (/\.optional\(\)|\.nullish\(\)|z\.array\(|z\.union\(/.test(decl)) continue;
      requeridas.push(km[1]!);
    }
    out.push({ nombre, requeridas });
  }
  return out;
}

function archivosDeCargadores(): string[] {
  const out: string[] = [];
  const caminar = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) caminar(p);
      else if (e.name === "queries.ts" || e.name === "nutrition-queries.ts") out.push(p);
    }
  };
  caminar(APP);
  return out;
}

let h: Harness;
const consultas: Consulta[] = [];
const noVerificables: string[] = [];

beforeAll(async () => {
  h = await levantarBase();
  for (const archivo of archivosDeCargadores()) {
    const rel = path.relative(APP, archivo);
    const fuente = readFileSync(archivo, "utf8");
    const extraidas = extraerConsultas(rel, fuente);
    consultas.push(...extraidas);
    const totales = (fuente.match(/\.select\(/g) ?? []).length;
    if (extraidas.length < totales) {
      noVerificables.push(`${rel}: ${totales - extraidas.length} de ${totales} selects son dinámicos`);
    }
  }
}, 120000);

afterAll(async () => {
  await h?.cerrar();
});

describe("§35 — las columnas que piden los cargadores EXISTEN en la base real", () => {
  it("el extractor encontró cargadores de verdad (no se quedó mudo)", () => {
    expect(consultas.length).toBeGreaterThan(15);
  });

  it("ninguna consulta pide una columna inexistente", async () => {
    const fallos: string[] = [];
    for (const c of consultas) {
      if (c.columnas.length > 0) {
        try {
          await h.comoAdmin(() =>
            h.db.query(`select ${c.columnas.join(", ")} from public.${c.tabla} limit 0`),
          );
        } catch (e) {
          fallos.push(`${c.archivo} · ${c.tabla}: ${(e as Error).message}`);
        }
      }
      for (const emb of c.embeds) {
        if (emb.columnas.length === 0) continue;
        try {
          await h.comoAdmin(() =>
            h.db.query(`select ${emb.columnas.join(", ")} from public.${emb.tabla} limit 0`),
          );
        } catch (e) {
          fallos.push(`${c.archivo} · embed ${emb.tabla}: ${(e as Error).message}`);
        }
      }
    }
    expect(fallos).toEqual([]);
  });
});

describe("§35 — lo que el schema EXIGE, el select lo pide", () => {
  it("ningún schema Zod requiere una columna que su cargador no consulta", () => {
    const fallos: string[] = [];
    for (const archivo of archivosDeCargadores()) {
      const fuente = readFileSync(archivo, "utf8");
      const rel = path.relative(APP, archivo);
      if (/columnsOf\(/.test(fuente)) continue; // derivado del schema: no se desincroniza
      const extraidas = extraerConsultas(rel, fuente);
      const totales = (fuente.match(/\.select\(/g) ?? []).length;
      if (extraidas.length < totales) continue; // declarado en "no verificables"

      const pedidas = new Set<string>();
      for (const c of extraidas) {
        c.columnas.forEach((x) => pedidas.add(x));
        c.embeds.forEach((e) => e.columnas.forEach((x) => pedidas.add(x)));
      }
      for (const s of extraerSchemas(fuente)) {
        for (const req of s.requeridas) {
          if (!pedidas.has(req)) {
            fallos.push(`${rel} · ${s.nombre} exige "${req}" y ningún select lo pide`);
          }
        }
      }
    }
    expect(fallos).toEqual([]);
  });

  it("declara qué cargadores quedan fuera del alcance estático", () => {
    // No es un fallo: es honestidad sobre lo que este chequeo NO puede afirmar.
    // Esos cargadores están cubiertos por sus tests de integración propios.
    if (noVerificables.length > 0) {
      console.info("Selects dinámicos (fuera del chequeo estático):\n  " + noVerificables.join("\n  "));
    }
    expect(noVerificables.length).toBeLessThan(archivosDeCargadores().length);
  });
});
