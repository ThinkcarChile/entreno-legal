import { describe, expect, it } from "vitest";
import { gs1CheckDigit, isValidBarcode, normalizeBarcode } from "./barcode";

describe("F. validación de barcode (multi-formato, no solo EAN-13)", () => {
  it("acepta EAN-13 válido (fixture interno 200...)", () => {
    expect(isValidBarcode("2000000000015")).toBe(true);
    expect(isValidBarcode("2000000000022")).toBe(true);
  });

  it("acepta EAN-8 y UPC-A válidos", () => {
    expect(isValidBarcode("96385074")).toBe(true); // EAN-8 de ejemplo GS1
    expect(isValidBarcode("036000291452")).toBe(true); // UPC-A de ejemplo
  });

  it("rechaza checksum inválido", () => {
    expect(isValidBarcode("2000000000016")).toBe(false);
    expect(isValidBarcode("036000291453")).toBe(false);
  });

  it("rechaza largos no GTIN y no numéricos", () => {
    expect(isValidBarcode("12345")).toBe(false);
    expect(isValidBarcode("abcdefgh")).toBe(false);
    expect(isValidBarcode("123456789")).toBe(false); // 9 dígitos
  });

  it("normaliza espacios y guiones", () => {
    expect(normalizeBarcode(" 200-0000 000015 ")).toBe("2000000000015");
    expect(isValidBarcode("200 0000 000 015")).toBe(true);
  });

  it("gs1CheckDigit calcula el dígito verificador", () => {
    expect(gs1CheckDigit("200000000001")).toBe(5);
    expect(gs1CheckDigit("03600029145")).toBe(2);
  });
});
