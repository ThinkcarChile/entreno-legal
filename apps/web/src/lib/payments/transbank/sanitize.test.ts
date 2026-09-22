import { describe, expect, it } from "vitest";

import {
  containsForbiddenKeys,
  maskToken,
  sanitizeProviderPayload,
  scrub,
} from "./sanitize";

const API_KEY = "579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C";
const COMMERCE = "597055555532";

/**
 * El SDK oficial construye sus errores interpolando el error de axios entero,
 * y ese error lleva `config.headers` con `Tbk-Api-Key-Secret`. Estas pruebas
 * existen porque ahí hay una vía real de fuga de la llave del comercio.
 */
describe("saneado de errores", () => {
  it("borra la llave secreta de un mensaje de error", () => {
    const leak = `AxiosError: Request failed\nheaders: {"Tbk-Api-Key-Secret":"${API_KEY}"}`;
    const safe = scrub(leak, [API_KEY, COMMERCE]);
    expect(safe).not.toContain(API_KEY);
    expect(safe).toContain("«oculto»");
  });

  it("borra también una credencial que no se le pasó, por su forma", () => {
    const unknownSecret = "A".repeat(64);
    expect(scrub(`fallo con ${unknownSecret}`)).not.toContain(unknownSecret);
  });

  it("enmascara el valor de una cabecera de Transbank", () => {
    expect(scrub("Tbk-Api-Key-Secret: abc123def456")).not.toContain("abc123def456");
  });

  it("no destroza un mensaje normal", () => {
    expect(scrub("La transacción fue rechazada por el emisor")).toBe(
      "La transacción fue rechazada por el emisor",
    );
  });
});

describe("enmascarado del token", () => {
  it("deja reconocerlo sin poder usarlo", () => {
    const token = "01ab23cd45ef67gh89ij01kl23mn45op67qr89st01uv23wx45yz67ab89cd01ef";
    const masked = maskToken(token);
    expect(masked).not.toBe(token);
    expect(masked).toContain("…");
    expect(masked!.length).toBeLessThan(20);
  });

  it("no revienta con valores ausentes", () => {
    expect(maskToken(null)).toBeNull();
    expect(maskToken(undefined)).toBeNull();
    expect(maskToken("corto")).toContain("…");
  });
});

describe("carga útil que se guarda", () => {
  it("conserva los campos de la transacción", () => {
    const clean = sanitizeProviderPayload({
      vci: "TSY",
      amount: 44000,
      status: "AUTHORIZED",
      buy_order: "HTF-1",
      response_code: 0,
      authorization_code: "123456",
    });
    expect(clean).toMatchObject({ amount: 44000, status: "AUTHORIZED", response_code: 0 });
  });

  it("es lista blanca: descarta cualquier campo que no conozca", () => {
    const clean = sanitizeProviderPayload({
      status: "AUTHORIZED",
      headers: { "Tbk-Api-Key-Secret": API_KEY },
      config: { auth: "secreto" },
      campo_nuevo_del_proveedor: "lo que sea",
    });
    expect(clean).toEqual({ status: "AUTHORIZED" });
    expect(JSON.stringify(clean)).not.toContain(API_KEY);
  });

  it("de la tarjeta guarda los cuatro últimos y tira el resto", () => {
    const clean = sanitizeProviderPayload({
      status: "AUTHORIZED",
      card_detail: { card_number: "4051885600446623", cvv: "123" },
    });
    expect(clean.card_last_digits).toBe("6623");
    expect(JSON.stringify(clean)).not.toContain("4051885600446623");
    expect(JSON.stringify(clean)).not.toContain("123");
  });

  it("nunca deja pasar una clave prohibida", () => {
    const dirty = {
      status: "AUTHORIZED",
      headers: { "Tbk-Api-Key-Secret": API_KEY },
      nested: { config: { apiKey: API_KEY } },
    };
    expect(containsForbiddenKeys(dirty)).toBe(true);
    expect(containsForbiddenKeys(sanitizeProviderPayload(dirty))).toBe(false);
  });

  it("no rompe con entradas raras", () => {
    expect(sanitizeProviderPayload(null)).toEqual({});
    expect(sanitizeProviderPayload("texto")).toEqual({});
    expect(containsForbiddenKeys(null)).toBe(false);
  });
});
