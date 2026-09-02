import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityParaLaBase } from "@/lib/auth/actor";
import type { Capability } from "@/lib/auth/actor";
import { EXISTING_ACTIONS, READ_RPCS, SCOPED_TABLES } from "./tool";

/**
 * GUARDAS ESTRUCTURALES DE LA FRONTERA.
 *
 * Molde: `integration/salud-privacidad.test.ts`. Son contratos sobre el código
 * fuente, no sobre un caso: si mañana alguien crea un cliente propio adentro de
 * una herramienta, arma un `.rpc()` con nombre variable o hace que un `catch`
 * devuelva OK, esto revienta en CI aunque todos los casos de prueba sigan
 * pasando.
 */

const AQUI = path.resolve(__dirname);
const WEB = path.resolve(__dirname, "..", "..", "..");
const SRC = path.resolve(__dirname, "..", "..");

function fuentes(raiz: string, conPruebas = false): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(raiz)) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) out.push(...fuentes(ruta, conPruebas));
    else if (/\.tsx?$/.test(nombre) && (conPruebas || !/\.test\./.test(nombre))) out.push(ruta);
  }
  return out;
}

const FRONTERA = [...fuentes(AQUI), path.join(SRC, "lib/auth/actor.ts")];

/**
 * Los comentarios se sacan antes de buscar. Estas guardas hablan de lo que el
 * código HACE, y un archivo que explica por qué `.rpc()` con nombre variable
 * está prohibido no puede fallar por explicarlo.
 */
function sinComentarios(texto: string): string {
  const sinBloques = texto.replace(/\/\*[\s\S]*?\*\//g, " ");
  return sinBloques
    .split("\n")
    .map((linea) => {
      const corte = linea.indexOf("//");
      return corte === -1 ? linea : linea.slice(0, corte);
    })
    .join("\n");
}

function leer(archivo: string): { rel: string; texto: string } {
  return {
    rel: path.relative(SRC, archivo),
    texto: sinComentarios(readFileSync(archivo, "utf8")),
  };
}

/** Devuelve el cuerpo de cada bloque `catch`, con las llaves balanceadas. */
function bloquesCatch(texto: string): string[] {
  const bloques: string[] = [];
  for (const m of texto.matchAll(/catch\s*(\([^)]*\))?\s*\{/g)) {
    let i = (m.index === undefined ? 0 : m.index) + m[0].length;
    const desde = i;
    let nivel = 1;
    while (i < texto.length && nivel > 0) {
      if (texto[i] === "{") nivel += 1;
      if (texto[i] === "}") nivel -= 1;
      i += 1;
    }
    bloques.push(texto.slice(desde, i - 1));
  }
  return bloques;
}

describe("la superficie del asistente no puede tocar la base por su cuenta", () => {
  it("ningún archivo de la frontera crea un cliente propio ni menciona service_role", () => {
    const ofensas: string[] = [];
    for (const archivo of FRONTERA) {
      const { rel, texto } = leer(archivo);
      if (/createClient\s*\(/.test(texto)) ofensas.push(`${rel}: createClient(`);
      if (/service_role/.test(texto)) ofensas.push(`${rel}: service_role`);
      if (/createSupabaseServer/.test(texto)) ofensas.push(`${rel}: createSupabaseServer`);
    }
    expect(ofensas).toEqual([]);
  });

  it("no hay `.rpc(` ni `.from(` con nombre variable", () => {
    // Un nombre que no es literal es un nombre que alguien puede elegir, y el
    // que elige puede ser el texto de una boleta.
    const ofensas: string[] = [];
    for (const archivo of FRONTERA) {
      const { rel, texto } = leer(archivo);
      for (const m of texto.matchAll(/\.rpc\(\s*(?!["'`])/g)) {
        ofensas.push(`${rel}: .rpc( con nombre variable (caracter ${m.index})`);
      }
      for (const m of texto.matchAll(/(?<!Buffer)\.from\(\s*(?!["'`])/g)) {
        ofensas.push(`${rel}: .from( con nombre variable (caracter ${m.index})`);
      }
    }
    expect(ofensas).toEqual([]);
  });

  it("ningún `catch` puede devolver OK, y ninguno queda vacío", () => {
    const ofensas: string[] = [];
    for (const archivo of FRONTERA) {
      const { rel, texto } = leer(archivo);
      for (const bloque of bloquesCatch(texto)) {
        if (bloque.trim().length === 0) ofensas.push(`${rel}: catch vacío`);
        if (/"OK"/.test(bloque)) ofensas.push(`${rel}: un catch menciona OK`);
      }
    }
    expect(ofensas).toEqual([]);
  });

  it("no se rellenan huecos con 0 ni con lista vacía", () => {
    const ofensas: string[] = [];
    for (const archivo of FRONTERA) {
      const { rel, texto } = leer(archivo);
      for (const m of texto.matchAll(/(\?\?|\|\|)\s*(0(?![.\d])|\[\s*\])/g)) {
        ofensas.push(`${rel}: "${m[0]}" (caracter ${m.index})`);
      }
    }
    expect(ofensas).toEqual([]);
  });

  it("nadie castea a ConfirmationGrant: la única fábrica es reclamar", () => {
    const ofensas: string[] = [];
    for (const archivo of fuentes(SRC, true)) {
      const { rel, texto } = leer(archivo);
      for (const m of texto.matchAll(/as\s+(unknown\s+as\s+)?ConfirmationGrant/g)) {
        ofensas.push(`${rel}: "${m[0]}"`);
      }
    }
    expect(ofensas).toEqual([]);
  });

  it("runActionTool solo se usa donde vive la confirmación", () => {
    // La lista es corta a propósito: cada archivo nuevo acá es una decisión, no
    // un descuido. `aceptarPropuesta` (etapa 4) se agrega cuando exista.
    const PERMITIDOS = new Set([
      path.join("domain", "assistant", "run-tool.ts"),
      path.join("domain", "assistant", "tipos-imposibles.ts"),
      path.join("domain", "assistant", "compuerta.test.ts"),
      path.join("domain", "assistant", "proyeccion-salida.test.ts"),
      path.join("domain", "assistant", "superficie.test.ts"),
    ]);
    const ofensas: string[] = [];
    for (const archivo of fuentes(SRC, true)) {
      const { rel, texto } = leer(archivo);
      if (PERMITIDOS.has(rel)) continue;
      if (/runActionTool/.test(texto)) ofensas.push(rel);
    }
    expect(ofensas).toEqual([]);
  });

  it("ningún componente de cliente alcanza node:crypto siguiendo sus imports", () => {
    /**
     * La tarjeta necesita `comparaSegundoGesto` para avisar sin red, y esa
     * comparación es UNA sola —la misma que corre dentro de la compuerta—
     * porque dos serían la trampa de las dos compuertas en chico. Pero
     * `proposal.ts` importa `node:crypto` en su primera línea, y un módulo que
     * llega al bundle del navegador arrastrando `node:crypto` no compila: el
     * salto tiene que ser a `segundo-gesto.ts`, que no importa nada.
     *
     * Esto se recorre TRANSITIVAMENTE porque el import que rompe nunca es el
     * que se ve en el componente: es el del módulo del módulo.
     */
    const resolver = (desde: string, spec: string): string | null => {
      const base = spec.startsWith("@/")
        ? path.join(SRC, spec.slice(2))
        : spec.startsWith(".")
          ? path.resolve(path.dirname(desde), spec)
          : null;
      if (base === null) return null;
      for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        try {
          if (statSync(cand).isFile()) return cand;
        } catch {
          // No es este candidato. Se prueba el siguiente; si no hay ninguno, el
          // import es de un paquete y no de nuestro árbol.
          continue;
        }
      }
      return null;
    };

    const ofensas: string[] = [];
    for (const entrada of fuentes(SRC).filter((f) => {
      const crudo = readFileSync(f, "utf8").trimStart();
      return crudo.startsWith('"use client"') || crudo.startsWith("'use client'");
    })) {
      const visto = new Set<string>();
      const pila: { archivo: string; camino: string[] }[] = [
        { archivo: entrada, camino: [path.relative(SRC, entrada)] },
      ];
      while (pila.length > 0) {
        const actual = pila.pop();
        if (actual === undefined) break;
        if (visto.has(actual.archivo)) continue;
        visto.add(actual.archivo);
        const crudo = readFileSync(actual.archivo, "utf8");
        // Un `"use server"` es una FRONTERA de bundle, no una dependencia: al
        // cliente le llega una referencia, no el módulo. Se corta acá — seguir
        // adentro sería acusar a media aplicación de algo que no pasa.
        if (
          actual.archivo !== entrada &&
          /^\s*("use server"|'use server')/.test(crudo.trimStart())
        ) {
          continue;
        }
        const texto = sinComentarios(crudo);
        // `import type` se borra al compilar: no llega al bundle.
        for (const m of texto.matchAll(
          /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+"([^"]+)"/g,
        )) {
          const spec = m[1];
          // El grupo existe siempre que la expresión calzó. Si faltara sería un
          // bug de la expresión, no un import raro: revienta y se arregla. Un
          // `?? ""` acá haría que la guarda dejara de mirar sin decirlo.
          if (spec === undefined) throw new Error(`import sin grupo en ${actual.archivo}`);
          if (spec.startsWith("node:")) {
            ofensas.push(`${actual.camino.join(" -> ")} importa ${spec}`);
            continue;
          }
          const destino = resolver(actual.archivo, spec);
          if (destino !== null) {
            pila.push({ archivo: destino, camino: [...actual.camino, path.relative(SRC, destino)] });
          }
        }
      }
    }
    expect(ofensas).toEqual([]);
  });

  it("la frontera no importa la sesión de Next ni el cliente de servidor", () => {
    const ofensas: string[] = [];
    for (const archivo of FRONTERA) {
      const { rel, texto } = leer(archivo);
      if (/from "next\//.test(texto)) ofensas.push(`${rel}: importa de next/`);
      if (/@\/lib\/supabase\/server/.test(texto)) {
        ofensas.push(`${rel}: importa el cliente de servidor`);
      }
    }
    expect(ofensas).toEqual([]);
  });
});

describe("los vocabularios cerrados están sanos", () => {
  it("no hay nombres repetidos en las listas literales", () => {
    for (const lista of [EXISTING_ACTIONS, READ_RPCS, SCOPED_TABLES]) {
      expect(new Set(lista).size).toBe(lista.length);
    }
  });

  it("ensure_weekly_plan no es un RPC de lectura: crea una semana entera", () => {
    // `previewDeltas` y los lectores del plan pasan por ahí y crean 1 fila en
    // weekly_plans + 7 en weekly_plan_days. Preguntar no puede inventar una
    // semana que nadie planificó.
    const nombres: readonly string[] = READ_RPCS;
    expect(nombres).not.toContain("ensure_weekly_plan");
  });
});

describe("el catálogo de lo que no compila sigue sin compilar", () => {
  it("tipos-imposibles.ts pasa por tsc con TODAS sus directivas usadas", () => {
    // Si alguien afloja un tipo de la compuerta, el error esperado desaparece,
    // la directiva `@ts-expect-error` queda sin usar y tsc falla con TS2578.
    // O sea: esta prueba se cae exactamente cuando el arreglo se revierte.
    const config = path.join(WEB, "tsconfig.compuerta.tmp.json");
    writeFileSync(
      config,
      JSON.stringify({
        extends: "./tsconfig.json",
        include: [],
        files: ["src/domain/assistant/tipos-imposibles.ts"],
      }),
      "utf8",
    );
    try {
      execFileSync("npx", ["tsc", "--noEmit", "-p", path.basename(config)], {
        cwd: WEB,
        stdio: "pipe",
        shell: process.platform === "win32",
      });
    } finally {
      rmSync(config, { force: true });
    }
  }, 120_000);
});

describe("un solo dueño por regla: la traducción de capacidades calza con el SQL", () => {
  const SQL = readFileSync(
    path.join(WEB, "..", "supabase", "migrations", "0050_asistente_ambito.sql"),
    "utf8",
  );

  it("cada `k` que la app escribe existe como rama de app.capabilities_ok", () => {
    const evaluables: Capability[] = [
      { k: "ROLE", flag: "isAdmin" },
      { k: "ROLE", flag: "canEditPlan" },
      { k: "ROLE", flag: "canManageShopping" },
      { k: "ROLE", flag: "canCook" },
      { k: "MEDICAL", owner: "x", permission: "READ_LABS" },
    ];
    const faltantes: string[] = [];
    for (const cap of evaluables) {
      const fila = capabilityParaLaBase(cap);
      if (fila === null) continue;
      if (!SQL.includes(`when '${fila.k}'`)) faltantes.push(fila.k);
    }
    expect(faltantes).toEqual([]);
  });

  it("lo de finanzas NO tiene rama: una `k` desconocida niega, que es lo correcto hoy", () => {
    expect(SQL).not.toContain("when 'FINANCE_HOUSEHOLD'");
    expect(SQL).not.toContain("when 'FINANCE_MEMBER'");
  });
});
