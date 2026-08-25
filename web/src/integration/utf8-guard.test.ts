import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GUARDIÁN UTF-8 (cierre v2 §8).
 *
 * Nace de un incidente REAL: las migraciones 0026/0027 se entregaron por
 * portapapeles con `clip` de Windows, que reescribe el UTF-8 en la página de
 * códigos del sistema. Llegaron a producción cinco nombres de biomarcador y
 * los mensajes de 22 funciones con los acentos mutilados ("Fósforo").
 *
 * En un módulo de salud un mensaje ilegible es un defecto: la persona tiene
 * que ENTENDER por qué el sistema se niega a algo. Este test es el cerrojo
 * que impide que vuelva a pasar, en migraciones y en código clínico.
 *
 * La 0028 queda como historia: corrigió el daño y NO se reescribe.
 */

const ROOT = path.resolve(__dirname, "../../..");
const MIGRACIONES = path.join(ROOT, "supabase", "migrations");
const SEEDS = path.join(ROOT, "supabase", "seed");
const CLINICO = path.resolve(__dirname, "..");

/** Secuencias que delatan UTF-8 leído como Latin-1/CP1252 (mojibake). */
const MOJIBAKE = [
  "Ã¡", "Ã©", "Ã­", "Ã³", "Ãº", "Ã±", "Ã", // UTF-8 → Latin-1
  "â", "â", "â", "â¦",                        // comillas y puntos suspensivos
  "Â·", "Â¿", "Â¡",                                  // signos con Â parásito
  "├", "┬", "Ô", "Ã",                                // UTF-8 → CP437/850 (`clip`)
];

function archivos(raiz: string, filtro: (n: string) => boolean): string[] {
  const out: string[] = [];
  let entradas: string[];
  try {
    entradas = readdirSync(raiz);
  } catch {
    return out;
  }
  for (const nombre of entradas) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) out.push(...archivos(ruta, filtro));
    else if (filtro(nombre)) out.push(ruta);
  }
  return out;
}

/** Reporta líneas con problemas de codificación en un archivo. */
function revisar(ruta: string): string[] {
  const problemas: string[] = [];
  const crudo = readFileSync(ruta);

  // 1. ¿Es UTF-8 válido? Node reemplaza los bytes inválidos por U+FFFD.
  const texto = crudo.toString("utf8");
  const reIdaVuelta = Buffer.from(texto, "utf8");
  if (!reIdaVuelta.equals(crudo)) {
    problemas.push("bytes que no son UTF-8 válido");
  }

  const lineas = texto.split("\n");
  lineas.forEach((linea, i) => {
    // 2. Carácter de reemplazo: el dato ya se perdió.
    if (linea.includes("�")) {
      problemas.push(`${i + 1}: carácter de reemplazo � — el texto original se perdió`);
    }
    // 3. Mojibake evidente.
    for (const patron of MOJIBAKE) {
      if (linea.includes(patron)) {
        problemas.push(`${i + 1}: mojibake "${patron}" en «${linea.trim().slice(0, 70)}»`);
        break;
      }
    }
  });
  return problemas;
}

describe("§8 — guardián de codificación", () => {
  it("ninguna migración tiene mojibake ni bytes inválidos", () => {
    const fallos: string[] = [];
    for (const ruta of archivos(MIGRACIONES, (n) => n.endsWith(".sql"))) {
      for (const p of revisar(ruta)) {
        fallos.push(`${path.basename(ruta)} · ${p}`);
      }
    }
    expect(fallos).toEqual([]);
  });

  it("ningún seed tiene mojibake ni bytes inválidos", () => {
    const fallos: string[] = [];
    for (const ruta of archivos(SEEDS, (n) => n.endsWith(".sql"))) {
      for (const p of revisar(ruta)) {
        fallos.push(`${path.basename(ruta)} · ${p}`);
      }
    }
    expect(fallos).toEqual([]);
  });

  it("el código clínico (dominio + app/health) está limpio", () => {
    const fallos: string[] = [];
    const objetivos = [
      ...archivos(path.join(CLINICO, "domain", "clinical"), (n) => /\.tsx?$/.test(n)),
      ...archivos(path.join(CLINICO, "app", "health"), (n) => /\.tsx?$/.test(n)),
    ];
    expect(objetivos.length).toBeGreaterThan(5);
    for (const ruta of objetivos) {
      for (const p of revisar(ruta)) {
        fallos.push(`${path.relative(CLINICO, ruta)} · ${p}`);
      }
    }
    expect(fallos).toEqual([]);
  });

  it("el guardián DETECTA mojibake real (prueba de que no es decorativo)", () => {
    // Se comprueba contra el daño exacto del incidente: "Fósforo" tal como
    // llegó a producción por el portapapeles.
    const dañado = Buffer.from("FÃ³sforo y AlbÃºmina", "utf8");
    const texto = dañado.toString("utf8");
    const detectado = MOJIBAKE.some((p) => texto.includes(p));
    expect(detectado).toBe(true);
  });
});
