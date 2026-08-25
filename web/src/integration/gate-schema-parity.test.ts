import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { levantarBase, type Harness } from "./harness";

/**
 * GATE FINAL §3 — PARIDAD DE SCHEMA: test == producción.
 *
 * Regla del director: "schema test == schema producible mediante migraciones;
 * un seed de demo no puede esconder una dependencia de producción".
 *
 * Este test levanta la base SOLO con migraciones (sin seeds) y exige que TODO
 * lo que la aplicación referencia —cada `.rpc("...")` y cada `.from("...")`—
 * exista ahí. Así, si mañana alguien define una función o tabla en un seed y
 * la app la usa, este test la delata antes de que Supabase la eche de menos
 * en producción (el caso real: `seed_demo_family_profiles`, que la app
 * llamaba y en el remoto existía solo porque el seed se corrió a mano).
 */

const APP = path.resolve(__dirname, "../app");
const LIB = path.resolve(__dirname, "../lib");

function archivosDeApp(raiz: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(raiz)) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) out.push(...archivosDeApp(ruta));
    else if (/\.tsx?$/.test(nombre) && !/\.test\./.test(nombre)) out.push(ruta);
  }
  return out;
}

function referencias(): { rpcs: Map<string, string[]>; tablas: Map<string, string[]> } {
  const rpcs = new Map<string, string[]>();
  const tablas = new Map<string, string[]>();
  for (const archivo of [...archivosDeApp(APP), ...archivosDeApp(LIB)]) {
    const fuente = readFileSync(archivo, "utf8");
    const rel = path.relative(APP, archivo);
    for (const m of fuente.matchAll(/\.rpc\(\s*"([a-z_0-9]+)"/g)) {
      const lista = rpcs.get(m[1]!) ?? [];
      lista.push(rel);
      rpcs.set(m[1]!, lista);
    }
    for (const m of fuente.matchAll(/\.from\(\s*"([a-z_0-9]+)"\s*\)/g)) {
      const lista = tablas.get(m[1]!) ?? [];
      lista.push(rel);
      tablas.set(m[1]!, lista);
    }
  }
  return { rpcs, tablas };
}

let h: Harness;

beforeAll(async () => {
  // SIN seeds: exactamente lo que las migraciones pueden producir.
  h = await levantarBase({ conSeeds: false });
});

afterAll(async () => {
  await h?.cerrar();
});

describe("§3 — la app solo depende de schema producible por migraciones", () => {
  it("toda función que la app invoca con .rpc() existe SIN seeds", async () => {
    const { rpcs } = referencias();
    expect(rpcs.size).toBeGreaterThan(5); // el scanner encontró algo real

    const existentes = new Set(
      (
        await h.filas<{ proname: string }>(
          `select p.proname from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'`,
        )
      ).map((f) => f.proname),
    );

    const faltantes = [...rpcs.entries()]
      .filter(([nombre]) => !existentes.has(nombre))
      .map(([nombre, usos]) => `${nombre} (usada en ${usos.join(", ")})`);
    expect(faltantes).toEqual([]);
  });

  it("toda tabla/vista que la app lee con .from() existe SIN seeds", async () => {
    const { tablas } = referencias();
    expect(tablas.size).toBeGreaterThan(10);

    const existentes = new Set(
      (
        await h.filas<{ relname: string }>(
          `select c.relname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')`,
        )
      ).map((f) => f.relname),
    );

    const faltantes = [...tablas.entries()]
      .filter(([nombre]) => !existentes.has(nombre))
      .map(([nombre, usos]) => `${nombre} (usada en ${usos.join(", ")})`);
    expect(faltantes).toEqual([]);
  });

  it("los seeds ya no definen objetos permanentes de schema", () => {
    // pg_temp.* es sesión-local y muere sola: permitida. Todo lo demás
    // (functions/tables/views/triggers/policies en public) va en migraciones.
    const seedDir = path.resolve(__dirname, "../../../supabase/seed");
    const ofensas: string[] = [];
    for (const nombre of readdirSync(seedDir)) {
      if (!nombre.endsWith(".sql")) continue;
      const fuente = readFileSync(path.join(seedDir, nombre), "utf8");
      for (const m of fuente.matchAll(
        /create\s+(?:or\s+replace\s+)?(function|table|view|trigger|policy)\s+([a-z_."]+)/gi,
      )) {
        if (m[2]!.startsWith("pg_temp.")) continue;
        ofensas.push(`${nombre}: create ${m[1]} ${m[2]}`);
      }
    }
    expect(ofensas).toEqual([]);
  });
});
