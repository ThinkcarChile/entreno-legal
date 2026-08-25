/**
 * NutritionAIEngine — capa de EXTRACCIÓN (ADR 0012, §2/§9/§54).
 *
 * Sustituible por diseño: hoy un parser determinista para documentos de texto
 * estructurado (el formato del examen sintético de demo); mañana un modelo.
 * Lo que NUNCA cambia: su output son CANDIDATOS que un humano revisa — esta
 * capa no tiene ninguna puerta al ClinicalRulesEngine.
 *
 * Si el documento no se puede leer (PDF/imagen sin extractor real), el
 * resultado es FAILED honesto — jamás un OCR improvisado de baja calidad.
 */

export interface ExtractionCandidate {
  biomarker_code: string | null;
  raw_label: string;
  value: number | null;
  /** null = el documento no traía unidad legible. JAMÁS se inventa. */
  unit: string | null;
  reference_low: number | null;
  reference_high: number | null;
  reference_text: string | null;
  collected_date: string | null;
  confidence: number;
  original_snippet: string;
}

export type ExtractionResult =
  | { ok: true; processorVersion: string; candidates: ExtractionCandidate[] }
  | { ok: false; processorVersion: string; error: string };

export const DEMO_PARSER_VERSION = "demo-parser/1.0.0";

/** Alias razonables del texto de un examen → código del catálogo. */
const ALIAS: Record<string, string> = {
  creatinina: "creatinine",
  creatinine: "creatinine",
  egfr: "egfr",
  "vfg": "egfr",
  uacr: "uacr",
  albuminuria: "uacr",
  potasio: "potassium",
  potassium: "potassium",
  fosforo: "phosphorus",
  "fósforo": "phosphorus",
  phosphorus: "phosphorus",
  sodio: "sodium",
  sodium: "sodium",
  bicarbonato: "bicarbonate",
  bun: "bun",
  calcio: "calcium",
  albumina: "albumin",
  "albúmina": "albumin",
  hemoglobina: "hemoglobin",
  glucosa: "glucose",
  glicemia: "glucose",
  hba1c: "hba1c",
  "hemoglobina glicada": "hba1c",
  "colesterol total": "total_cholesterol",
  ldl: "ldl",
  hdl: "hdl",
  trigliceridos: "triglycerides",
  "triglicéridos": "triglycerides",
};

/**
 * Parser del examen sintético: líneas `Etiqueta: valor unidad (rango) [fecha]`
 * o el formato CSV `etiqueta;valor;unidad;rango_bajo-rango_alto;fecha`.
 * Determinista: mismo texto, mismos candidatos.
 */
export function extractFromText(content: string, mimeType: string): ExtractionResult {
  if (!mimeType.startsWith("text/")) {
    return {
      ok: false,
      processorVersion: DEMO_PARSER_VERSION,
      error:
        "Este extractor solo lee texto estructurado. PDF/imagen requieren un extractor real: el documento queda para revisión manual.",
    };
  }

  const candidates: ExtractionCandidate[] = [];
  for (const lineaCruda of content.split("\n")) {
    const linea = lineaCruda.trim();
    if (!linea || linea.startsWith("#")) continue;

    let etiqueta = "";
    let valorTxt = "";
    let unidad: string | null = null;
    let refLow: number | null = null;
    let refHigh: number | null = null;
    let refText: string | null = null;
    let fecha: string | null = null;

    if (linea.includes(";")) {
      const partes = linea.split(";").map((p) => p.trim());
      etiqueta = partes[0] ?? "";
      valorTxt = partes[1] ?? "";
      unidad = partes[2] || null;
      if (partes[3]) {
        refText = partes[3];
        const m = partes[3].match(/^([\d.,]+)\s*[-–]\s*([\d.,]+)$/);
        if (m) {
          refLow = Number(m[1]!.replace(",", "."));
          refHigh = Number(m[2]!.replace(",", "."));
        }
      }
      fecha = partes[4] && /^\d{4}-\d{2}-\d{2}$/.test(partes[4]) ? partes[4] : null;
    } else {
      const m = linea.match(
        /^([^:]+):\s*([\d.,]+)\s*([^\s(]+)?\s*(?:\(([^)]*)\))?\s*(?:\[(\d{4}-\d{2}-\d{2})\])?$/,
      );
      if (!m) continue;
      etiqueta = m[1]!.trim();
      valorTxt = m[2]!;
      unidad = m[3] ?? null;
      refText = m[4] ?? null;
      fecha = m[5] ?? null;
      if (refText) {
        const r = refText.match(/([\d.,]+)\s*[-–]\s*([\d.,]+)/);
        if (r) {
          refLow = Number(r[1]!.replace(",", "."));
          refHigh = Number(r[2]!.replace(",", "."));
        }
      }
    }

    if (!etiqueta) continue;
    const valor = valorTxt ? Number(valorTxt.replace(",", ".")) : null;
    const codigo = ALIAS[etiqueta.toLowerCase()] ?? null;

    candidates.push({
      biomarker_code: codigo,
      raw_label: etiqueta,
      value: Number.isFinite(valor) ? valor : null,
      unit: unidad,
      reference_low: refLow,
      reference_high: refHigh,
      reference_text: refText,
      collected_date: fecha,
      // Confianza honesta: alta solo con biomarcador reconocido + valor + unidad.
      confidence:
        codigo && valor !== null && unidad ? 0.9 : codigo && valor !== null ? 0.6 : 0.3,
      original_snippet: linea.slice(0, 500),
    });
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      processorVersion: DEMO_PARSER_VERSION,
      error: "No se reconoció ninguna fila de resultados en el documento.",
    };
  }
  return { ok: true, processorVersion: DEMO_PARSER_VERSION, candidates };
}
