/**
 * Generación de etiquetas en PDF REAL (§66): dimensiones físicas de la
 * plantilla respetadas (mm → puntos), pensado para impresora térmica
 * monocroma (§34): negro sobre blanco, DÍA DE USO grande primero.
 *
 * El contenido sale del SNAPSHOT congelado del print job (§40) — jamás del
 * estado vivo del lote. El QR lleva SOLO la URL con el token opaco (§35).
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { z } from "zod";

export const labelSnapshotSchema = z.object({
  label: z.string(),
  quantity: z.union([z.number(), z.string().transform(Number)]),
  unit: z.enum(["G", "ML", "UNIT"]),
  processing_state: z.enum(["RAW", "PREPPED", "COOKED"]).nullish(),
  temperature_state: z.enum(["AMBIENT", "CHILLED", "FROZEN"]).nullish(),
  vacuum_sealed: z.boolean().nullish(),
  prepared_on: z.string().nullish(),
  intended_use_date: z.string().nullish(),
  intended_meal: z.string().nullish(),
  safe_use_by: z.string().nullish(),
  location: z.string().nullish(),
  package_code: z.string().nullish(),
  qr_token: z.string(),
  template: z.object({
    width_mm: z.union([z.number(), z.string().transform(Number)]),
    height_mm: z.union([z.number(), z.string().transform(Number)]).nullish(),
    margin_mm: z.union([z.number(), z.string().transform(Number)]).default(2),
    layout: z.unknown().nullish(),
  }),
});

export type LabelSnapshot = z.infer<typeof labelSnapshotSchema>;

const MM = 72 / 25.4;

const DIA_LARGO = ["DOMINGO", "LUNES", "MARTES", "MIÉRCOLES", "JUEVES", "VIERNES", "SÁBADO"];

function diaGrande(date: string | null | undefined): string | null {
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  return DIA_LARGO[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? null;
}

function fechaCorta(date: string | null | undefined): string | null {
  if (!date) return null;
  const [, m, d] = date.split("-");
  return d && m ? `${d}/${m}` : null;
}

function estadoTexto(s: LabelSnapshot): string {
  const temp =
    s.temperature_state === "FROZEN"
      ? "Congelado"
      : s.temperature_state === "CHILLED"
        ? "Refrigerado"
        : "Ambiente";
  const proc = s.processing_state === "COOKED" ? " · cocido" : s.processing_state === "PREPPED" ? " · preparado" : "";
  const vac = s.vacuum_sealed ? " · al vacío" : "";
  return temp + proc + vac;
}

function cantidadTexto(s: LabelSnapshot): string {
  const unidad = s.unit === "G" ? "g" : s.unit === "ML" ? "ml" : "unid.";
  const n = Number.isInteger(s.quantity) ? String(s.quantity) : s.quantity.toFixed(1);
  return `${n} ${unidad}`;
}

/** Encoge la fuente hasta que el texto quepa; si aún no cabe, recorta con "…". */
function ajustar(font: PDFFont, text: string, maxWidth: number, size: number, minSize = 5): { text: string; size: number } {
  let s = size;
  while (s > minSize && font.widthOfTextAtSize(text, s) > maxWidth) s -= 0.5;
  if (font.widthOfTextAtSize(text, s) <= maxWidth) return { text, size: s };
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t + "…", s) > maxWidth) t = t.slice(0, -1);
  return { text: t + "…", size: s };
}

async function dibujarEtiqueta(
  page: PDFPage,
  snapshot: LabelSnapshot,
  fonts: { bold: PDFFont; regular: PDFFont },
  qrPng: Uint8Array | null,
  doc: PDFDocument,
): Promise<void> {
  const { width, height } = page.getSize();
  const margin = snapshot.template.margin_mm * MM;
  const inner = width - margin * 2;
  const negro = rgb(0, 0, 0);
  let y = height - margin;

  const linea = (texto: string, font: PDFFont, size: number, gap = 1.5) => {
    const fit = ajustar(font, texto, inner, size);
    y -= fit.size;
    page.drawText(fit.text, { x: margin, y, size: fit.size, font, color: negro });
    y -= gap;
  };

  // §34: prioridad visual = DÍA DE USO, grande.
  const dia = diaGrande(snapshot.intended_use_date);
  if (dia) linea(dia, fonts.bold, 16, 3);

  linea(snapshot.label.toUpperCase(), fonts.bold, 11, 1);
  linea(cantidadTexto(snapshot), fonts.bold, 10, 3);
  linea(estadoTexto(snapshot), fonts.regular, 7, 2);

  const preparado = fechaCorta(snapshot.prepared_on);
  if (preparado) linea(`Preparado: ${preparado}`, fonts.regular, 7, 1);

  if (snapshot.intended_use_date) {
    const para = `Para: ${snapshot.intended_meal ?? "comida"} ${fechaCorta(snapshot.intended_use_date)}`;
    linea(para, fonts.regular, 7, 1);
  }

  // §26: la fecha de seguridad SOLO si existe evaluada — y se distingue del uso.
  if (snapshot.safe_use_by) {
    linea(`Usar antes de: ${fechaCorta(snapshot.safe_use_by)}`, fonts.bold, 7, 1);
  }
  if (snapshot.location) linea(snapshot.location, fonts.regular, 6, 1);
  if (snapshot.package_code) linea(snapshot.package_code, fonts.regular, 6, 2);

  // QR abajo (§34), del tamaño que quepa en lo que queda.
  if (qrPng) {
    const disponible = Math.max(0, y - margin);
    const lado = Math.min(inner, disponible, 22 * MM);
    if (lado >= 8 * MM) {
      const img = await doc.embedPng(qrPng);
      page.drawImage(img, {
        x: (width - lado) / 2,
        y: margin,
        width: lado,
        height: lado,
      });
    }
  }
}

/**
 * PDF con una página POR etiqueta, cada una del tamaño físico de su plantilla.
 * `qrBaseUrl` es el origen de la app; el QR final es `{base}/q/{token}`.
 */
export async function generateLabelsPdf(
  snapshots: LabelSnapshot[],
  qrBaseUrl: string,
): Promise<Uint8Array> {
  if (snapshots.length === 0) throw new Error("sin etiquetas que generar");
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);

  for (const snapshot of snapshots) {
    const w = snapshot.template.width_mm * MM;
    const h = (snapshot.template.height_mm ?? 60) * MM;
    const page = doc.addPage([w, h]);
    const qrPng = await QRCode.toBuffer(`${qrBaseUrl}/q/${snapshot.qr_token}`, {
      margin: 0,
      width: 256,
      errorCorrectionLevel: "M",
    });
    await dibujarEtiqueta(page, snapshot, { bold, regular }, qrPng, doc);
  }
  return doc.save();
}
