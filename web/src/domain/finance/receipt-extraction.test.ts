import { describe, expect, it } from "vitest";
import {
  RECEIPT_PARSER_VERSION,
  eanCheckDigitOk,
  extractReceiptFromText,
  lineMismatchMinor,
} from "./receipt-extraction";

/**
 * La frontera de extracción, del lado puro.
 *
 * Cada prueba de acá está escrita para ponerse ROJA si el arreglo se revierte:
 * no comprueba "que la función exista", comprueba el dígito exacto que separa
 * $1.990 de $17.990 y 1 kg de 10 kg.
 */

const BOLETA = [
  "COMERCIO: Supermercado Los Aromos",
  "FECHA: 2026-08-20",
  "BOLETA: 1234567",
  "TOTAL: 8.677",
  "--",
  "descripcion;cantidad;unidad;precio;base;total;descuento;codigo",
  "POLLO ENTERO;1340;G;4990;PER_KG;6687;;",
  "ARROZ GRANO LARGO 1KG;1;UNIT;1990;PER_UNIT;1990;;7801234567894",
].join("\n");

describe("el dígito verificador del código de barras", () => {
  it("valida EAN-13, EAN-8 y UPC-A reales", () => {
    expect(eanCheckDigitOk("7801234567894")).toBe(true); // EAN-13
    expect(eanCheckDigitOk("96385074")).toBe(true); // EAN-8
    expect(eanCheckDigitOk("036000291452")).toBe(true); // UPC-A
  });

  it("rechaza el mismo código con UN dígito cambiado", () => {
    // Este es el caso completo: un EAN con un dígito mal leído puede apuntar a
    // otro producto REAL del catálogo. Sin este chequeo entraría con score 1.0.
    expect(eanCheckDigitOk("7801234567895")).toBe(false);
    expect(eanCheckDigitOk("96385075")).toBe(false);
  });

  it("rechaza la basura sin lanzar: quien pregunta necesita una respuesta", () => {
    expect(eanCheckDigitOk(null)).toBe(false);
    expect(eanCheckDigitOk("")).toBe(false);
    expect(eanCheckDigitOk("78012A4567890")).toBe(false);
    expect(eanCheckDigitOk("7801234567894123456")).toBe(false);
    expect(eanCheckDigitOk("123")).toBe(false); // largo inexistente
  });
});

describe("la aritmética de la línea atrapa el dígito mal leído", () => {
  const pollo = {
    unitPriceMinor: 4990n,
    unitPriceBasis: "PER_KG" as const,
    quantity: 1340,
    unit: "G" as const,
    lineTotalMinor: 6687n,
  };

  it("una línea de pesable que cuadra da descuadre cero", () => {
    // 1,340 kg × $4.990 = $6.686,6 → el comercio imprime 6.687. La tolerancia
    // por línea del CLP (1 peso) lo absorbe; el descuadre igual se REPORTA.
    expect(lineMismatchMinor(pollo)).toBe(1n);
  });

  it("«10 kg» donde decía «1 kg» revienta el cuadre por miles de pesos", () => {
    const diezVeces = lineMismatchMinor({ ...pollo, quantity: 13400 });
    expect(diezVeces).not.toBeNull();
    expect(diezVeces! < -50000n).toBe(true);
  });

  it("$499 donde decía $4.990 también revienta el cuadre", () => {
    const precioMalLeido = lineMismatchMinor({ ...pollo, unitPriceMinor: 499n });
    expect(precioMalLeido).not.toBeNull();
    expect(precioMalLeido! > 5000n).toBe(true);
  });

  it("sin la base del precio NO hay chequeo, y eso se dice con null (jamás con 0)", () => {
    // Devolver 0 acá diría "cuadra" y sería la mentira más cara del módulo:
    // "no verificado" y "verificado y correcto" no son lo mismo.
    expect(lineMismatchMinor({ ...pollo, unitPriceBasis: null })).toBeNull();
    expect(lineMismatchMinor({ ...pollo, lineTotalMinor: null })).toBeNull();
    expect(lineMismatchMinor({ ...pollo, quantity: null })).toBeNull();
  });

  it("una base que no habla de la misma dimensión que la unidad no se fuerza", () => {
    // $/litro contra gramos: convertir exigiría una densidad que nadie declaró.
    expect(lineMismatchMinor({ ...pollo, unitPriceBasis: "PER_L" })).toBeNull();
  });

  it("PER_100G y PER_UNIT calculan lo suyo", () => {
    expect(
      lineMismatchMinor({
        unitPriceMinor: 500n,
        unitPriceBasis: "PER_100G",
        quantity: 250,
        unit: "G",
        lineTotalMinor: 1250n,
      }),
    ).toBe(0n);
    expect(
      lineMismatchMinor({
        unitPriceMinor: 1990n,
        unitPriceBasis: "PER_UNIT",
        quantity: 3,
        unit: "UNIT",
        lineTotalMinor: 5970n,
      }),
    ).toBe(0n);
  });
});

describe("el parser de boletas en texto", () => {
  it("lee encabezado y líneas, y es determinista", () => {
    const uno = extractReceiptFromText(BOLETA, "text/plain");
    const dos = extractReceiptFromText(BOLETA, "text/plain");
    expect(uno.ok).toBe(true);
    expect(uno).toEqual(dos);
    if (!uno.ok) return;

    expect(uno.processorVersion).toBe(RECEIPT_PARSER_VERSION);
    expect(uno.header.merchant_name).toBe("Supermercado Los Aromos");
    expect(uno.header.receipt_date).toBe("2026-08-20");
    expect(uno.header.receipt_number).toBe("1234567");
    // El separador de miles chileno se saca; el total entra en unidades menores.
    expect(uno.header.declared_total_minor).toBe("8677");
    expect(uno.header.total_source).toBe("PRINTED");
    expect(uno.candidates).toHaveLength(2);
    expect(uno.candidates[0]!.line_total_minor).toBe("6687");
    expect(uno.candidates[0]!.unit_price_basis).toBe("PER_KG");
  });

  it("un total ilegible queda UNKNOWN, jamás en cero", () => {
    // «$0 impreso» es exactamente como se ve un OCR que no leyó nada, y ese cero
    // después se compara contra la suma de las líneas y ancla toda la boleta.
    const sinTotal = extractReceiptFromText(BOLETA.replace("TOTAL: 8.677", "TOTAL: ~~~"), "text/plain");
    expect(sinTotal.ok).toBe(true);
    if (!sinTotal.ok) return;
    expect(sinTotal.header.declared_total_minor).toBeNull();
    expect(sinTotal.header.total_source).toBe("UNKNOWN");
  });

  it("no inventa la unidad cuando la boleta no la trae", () => {
    const sinUnidad = extractReceiptFromText(
      BOLETA.replace("POLLO ENTERO;1340;G;", "POLLO ENTERO;1340;;"),
      "text/plain",
    );
    expect(sinUnidad.ok).toBe(true);
    if (!sinUnidad.ok) return;
    expect(sinUnidad.candidates[0]!.unit).toBeNull();
  });

  it("un código de barras que no valida NO se usa como vía de match", () => {
    const malLeido = extractReceiptFromText(
      BOLETA.replace("7801234567894", "7801234567895"),
      "text/plain",
    );
    expect(malLeido.ok).toBe(true);
    if (!malLeido.ok) return;
    const arroz = malLeido.candidates[1]!;
    expect(arroz.barcode).toBe("7801234567895");
    expect(arroz.match_method).toBe("NONE");
    expect(arroz.match_score).toBeNull();
    expect(arroz.field_confidences.barcode).toBe(0);
  });

  it("un total de línea ilegible viaja como null, no como cero", () => {
    const roto = extractReceiptFromText(
      BOLETA.replace(";PER_KG;6687;", ";PER_KG;$$$;"),
      "text/plain",
    );
    expect(roto.ok).toBe(true);
    if (!roto.ok) return;
    expect(roto.candidates[0]!.line_total_minor).toBeNull();
    expect(roto.candidates[0]!.field_confidences.line_total).toBeUndefined();
  });

  it("una foto o un PDF dan FAILED honesto, jamás un OCR improvisado", () => {
    const foto = extractReceiptFromText("", "image/jpeg");
    expect(foto.ok).toBe(false);
    if (foto.ok) return;
    expect(foto.error).toContain("extractor real");

    const pdf = extractReceiptFromText("cualquier cosa", "application/pdf");
    expect(pdf.ok).toBe(false);
  });

  it("un texto sin ninguna línea legible es una lectura FALLIDA, no una compra vacía", () => {
    const vacia = extractReceiptFromText("COMERCIO: Nadie\nFECHA: 2026-08-20\n", "text/plain");
    expect(vacia.ok).toBe(false);
  });
});
