/**
 * Validación razonable de códigos de barra (ADR 0001 §5).
 * Soporta GTIN: EAN-8, UPC-A (12), EAN-13 y GTIN-14, con dígito verificador GS1.
 * No se asume EAN-13 universal.
 */

export function normalizeBarcode(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

export function isValidBarcode(raw: string): boolean {
  const code = normalizeBarcode(raw);
  if (!/^\d+$/.test(code) || !GTIN_LENGTHS.has(code.length)) return false;
  return gs1CheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

/** Dígito verificador GS1 para el cuerpo del código (sin el último dígito). */
export function gs1CheckDigit(body: string): number {
  let sum = 0;
  // Pesos 3/1 alternados desde la derecha (posición adyacente al check = 3)
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}
