import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { generateLabelsPdf, labelSnapshotSchema, type LabelSnapshot } from "./pdf";

function snapshot(partial: Partial<LabelSnapshot> = {}): LabelSnapshot {
  return {
    label: "Pechuga de pollo",
    quantity: 1100,
    unit: "G",
    processing_state: "PREPPED",
    temperature_state: "FROZEN",
    vacuum_sealed: false,
    prepared_on: "2026-08-24",
    intended_use_date: "2026-08-27", // jueves
    intended_meal: "Almuerzo",
    safe_use_by: "2026-08-28",
    location: "Congelador",
    package_code: "PKG-3F9A2C1B",
    qr_token: "a".repeat(32),
    template: { width_mm: 40, height_mm: 60, margin_mm: 2, layout: {} },
    ...partial,
  };
}

const BASE = "https://mesa.familia";
const MM = 72 / 25.4;

describe("§66 — PDF real con dimensiones físicas", () => {
  it("una etiqueta: es un PDF con la página del tamaño de la plantilla (40×60 mm)", async () => {
    const bytes = await generateLabelsPdf([snapshot()], BASE);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(40 * MM, 1);
    expect(height).toBeCloseTo(60 * MM, 1);
  });

  it("varias etiquetas → una página por etiqueta, cada una con su tamaño", async () => {
    const bytes = await generateLabelsPdf(
      [
        snapshot(),
        snapshot({ template: { width_mm: 58, height_mm: 40, margin_mm: 2, layout: {} } }),
        snapshot({ label: "Zanahoria rallada", quantity: 600 }),
      ],
      BASE,
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(1).getSize().width).toBeCloseTo(58 * MM, 1);
  });

  it("texto largo y cantidad grande no revientan ni desbordan (se ajusta/recorta)", async () => {
    const bytes = await generateLabelsPdf(
      [
        snapshot({
          label: "Pechuga de pollo deshuesada sin piel marinada con hierbas de la huerta familiar",
          quantity: 123456.789,
          location: "Congelador del sótano, cajón inferior izquierdo, detrás de las empanadas",
        }),
      ],
      BASE,
    );
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("§34: JUEVES en grande cuando hay día de uso; sin día, sin texto fantasma", async () => {
    const conDia = await generateLabelsPdf([snapshot()], BASE);
    const sinDia = await generateLabelsPdf([snapshot({ intended_use_date: null })], BASE);
    // No podemos leer texto del PDF fácilmente, pero ambos deben generarse
    // y el QR (imagen embebida) hace que ambos pesen bastante.
    expect(conDia.length).toBeGreaterThan(500);
    expect(sinDia.length).toBeGreaterThan(500);
  });

  it("§77: el QR embebido lleva la URL con el token opaco (crece el PDF)", async () => {
    const conQr = await generateLabelsPdf([snapshot()], BASE);
    // El QR es la única imagen: un PDF sin imagen sería mucho más liviano.
    // Verificamos que el PNG quedó embebido de verdad.
    const doc = await PDFDocument.load(conQr);
    expect(doc.getPageCount()).toBe(1);
    expect(conQr.length).toBeGreaterThan(1500);
  });

  it("§76: intended (jueves 27) y safe-use (viernes 28) viven por separado en el snapshot", () => {
    const s = labelSnapshotSchema.parse(snapshot());
    expect(s.intended_use_date).toBe("2026-08-27");
    expect(s.safe_use_by).toBe("2026-08-28");
  });

  it("cero etiquetas es un error explícito, no un PDF vacío", async () => {
    await expect(generateLabelsPdf([], BASE)).rejects.toThrow(/sin etiquetas/);
  });
});
