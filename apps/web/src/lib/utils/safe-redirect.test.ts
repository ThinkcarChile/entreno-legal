import { describe, expect, it } from "vitest";

import { safeNextPath } from "./safe-redirect";

describe("safeNextPath", () => {
  it("conserva una ruta interna con consulta y ancla", () => {
    expect(safeNextPath("/mis-trabajos/abc?pago=ok#detalle")).toBe("/mis-trabajos/abc?pago=ok#detalle");
    expect(safeNextPath("/nueva-clave")).toBe("/nueva-clave");
  });

  it("sin valor usa el destino por omisión", () => {
    expect(safeNextPath(null)).toBe("/trabajos");
    expect(safeNextPath("")).toBe("/trabajos");
    expect(safeNextPath(undefined, "/cuenta")).toBe("/cuenta");
  });

  it.each([
    ["dominio absoluto", "https://evil.example/robar"],
    ["protocolo relativo", "//evil.example"],
    ["barra invertida", "/\\evil.example"],
    ["barra invertida en medio", "/ruta\\..\\x"],
    ["concatenado al origen: sufijo de dominio", ".evil.example"],
    ["concatenado al origen: credenciales", "@evil.example"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,hola"],
    ["sin barra inicial", "mis-trabajos"],
    ["salto de línea", "/ok\nLocation: https://evil.example"],
    ["tabulación", "/\t/evil.example"],
  ])("rechaza %s", (_label, value) => {
    expect(safeNextPath(value)).toBe("/trabajos");
  });
});
