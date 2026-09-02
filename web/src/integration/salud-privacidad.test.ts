import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SPRINT 11 — Guardas ESTRUCTURALES de privacidad clínica (§44/§45/§83/§84)
 * y de semántica UNKNOWN (§88). Son contratos sobre el código: si mañana
 * alguien importa datos clínicos en una etiqueta, esto revienta en CI.
 */

const SRC = path.resolve(__dirname, "..");

function archivos(raiz: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(raiz)) {
    const ruta = path.join(raiz, nombre);
    if (statSync(ruta).isDirectory()) out.push(...archivos(ruta));
    else if (/\.tsx?$/.test(nombre) && !/\.test\./.test(nombre)) out.push(ruta);
  }
  return out;
}

describe("§45/§83/§84 — cocina, compras, etiquetas y QR sin datos clínicos", () => {
  // Superficies que JAMÁS importan del dominio clínico ni del módulo health.
  // La única divulgación permitida es el estado categórico del serving, que
  // vive en plan/ (y no requiere importar nada clínico).
  //
  // Sprint 15: entran /inbox, /asistente y las piezas de la tarjeta. La bandeja
  // y el chat le muestran avisos de TODA la casa a quien tenga los permisos, y
  // son la superficie donde un import distraído al dominio clínico filtraría el
  // biomarcador entero dentro de una frase compuesta. Lo clínico que sí pueden
  // mostrar viaja ya categórico dentro del resumen de la propuesta o del aviso,
  // filtrado por la RLS (0053/0056), no leído desde acá.
  const SUPERFICIES_LIMPIAS = ["app/q", "lib/labels", "app/shopping", "app/prep", "app/procurement", "app/pantry", "app/stock", "app/inbox", "app/asistente", "components/assistant"];

  it("ninguna superficie de cocina/compras/etiquetas importa del módulo clínico", () => {
    const ofensas: string[] = [];
    for (const superficie of SUPERFICIES_LIMPIAS) {
      const dir = path.join(SRC, superficie);
      for (const archivo of archivos(dir)) {
        const fuente = readFileSync(archivo, "utf8");
        if (/@\/domain\/clinical|@\/app\/health|lab_observations|lab_documents|member_clinical_restrictions|biomarker/i.test(fuente)) {
          ofensas.push(path.relative(SRC, archivo));
        }
      }
    }
    expect(ofensas).toEqual([]);
  });

  it("el PDF de etiquetas y el QR no contienen campos clínicos ni de diagnóstico", () => {
    const sensibles = /diagn[oó]stico|biomarker|clinical|medicaci[oó]n|lab_/i;
    for (const archivo of ["lib/labels/pdf.ts"]) {
      const fuente = readFileSync(path.join(SRC, archivo), "utf8");
      expect(sensibles.test(fuente), `${archivo} menciona datos clínicos`).toBe(false);
    }
  });
});

describe("§88 — UNKNOWN NEVER MEANS NORMAL en el módulo clínico", () => {
  it("ni domain/clinical ni app/health convierten desconocido en 0 o en normal", () => {
    const ofensas: string[] = [];
    for (const dir of ["domain/clinical", "app/health"]) {
      for (const archivo of archivos(path.join(SRC, dir))) {
        const fuente = readFileSync(archivo, "utf8");
        const rel = path.relative(SRC, archivo);
        for (const m of fuente.matchAll(/\?\?\s*0(?![.\d])|\|\|\s*0(?![.\d])/g)) {
          const linea = fuente.slice(0, m.index).split("\n").length;
          ofensas.push(`${rel}:${linea} · ${fuente.split("\n")[linea - 1]!.trim().slice(0, 80)}`);
        }
      }
    }
    expect(ofensas).toEqual([]);
  });

  it("el motor jamás usa Date.now/new Date(): la fecha viene del hogar", () => {
    for (const archivo of archivos(path.join(SRC, "domain/clinical"))) {
      const fuente = readFileSync(archivo, "utf8");
      expect(/new Date\(\)|Date\.now\(\)/.test(fuente), `${path.basename(archivo)} usa reloj propio`).toBe(false);
    }
  });

  it("solo el motor determinista decide estados clínicos (la IA no aparece en engine.ts)", () => {
    const fuente = readFileSync(path.join(SRC, "domain/clinical/engine.ts"), "utf8");
    expect(/extractFromText|NutritionAI|openai|anthropic|llm/i.test(fuente)).toBe(false);
  });
});

describe("§95 — lenguaje clínico honesto", () => {
  it("ninguna pantalla de salud afirma 'saludable para ti' ni diagnostica", () => {
    const prohibidas = /saludable para ti|tu ri[ñn][oó]n|est[aá]s? (mejorando|empeorando)|peligros[oa]/i;
    for (const archivo of archivos(path.join(SRC, "app/health"))) {
      const fuente = readFileSync(archivo, "utf8");
      expect(prohibidas.test(fuente), `${path.relative(SRC, archivo)} usa lenguaje diagnóstico`).toBe(false);
    }
  });
});
