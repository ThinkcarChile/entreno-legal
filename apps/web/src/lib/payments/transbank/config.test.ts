import { describe, expect, it } from "vitest";

import {
  INTEGRATION_API_KEY,
  INTEGRATION_COMMERCE_CODE,
  isTrustedRedirect,
  looksLikeIntegrationCredential,
  productionBlockers,
  siteUrlBlockers,
  type GuardContext,
} from "./config";

/** Una configuración productiva impecable. Cada prueba rompe UNA cosa. */
const GOOD: GuardContext = {
  environment: "production",
  productionEnabled: true,
  commerceCode: "597000000001",
  apiKeySecret: "una-llave-productiva-de-verdad-larga",
  siteUrl: "https://hagotufila.cl",
  nodeEnv: "production",
  demoMode: false,
  selectedProvider: "transbank",
};

describe("guardas de producción", () => {
  it("con todo en orden no hay bloqueadores", () => {
    expect(productionBlockers(GOOD)).toEqual([]);
  });

  it.each([
    ["el ambiente no es production", { environment: "integration" as const }],
    ["falta la bandera explícita", { productionEnabled: false }],
    ["NODE_ENV no es production", { nodeEnv: "development" }],
    ["falta el código de comercio", { commerceCode: undefined }],
    ["falta la llave secreta", { apiKeySecret: undefined }],
    ["la aplicación está en modo demostración", { demoMode: true }],
    ["el proveedor seleccionado no es transbank", { selectedProvider: "mock" }],
    ["la URL no es HTTPS", { siteUrl: "http://hagotufila.cl" }],
    ["la URL es localhost", { siteUrl: "https://localhost" }],
    ["la URL lleva puerto local", { siteUrl: "https://hagotufila.cl:3000" }],
  ])("bloquea producción cuando %s", (_caso, patch) => {
    const blockers = productionBlockers({ ...GOOD, ...patch });
    expect(blockers.length).toBeGreaterThan(0);
  });

  it("bloquea si las credenciales productivas son las de integración", () => {
    const withIntegrationKey = productionBlockers({
      ...GOOD,
      apiKeySecret: String(INTEGRATION_API_KEY),
    });
    expect(withIntegrationKey.join(" ")).toContain("integración");

    const withIntegrationCode = productionBlockers({
      ...GOOD,
      commerceCode: String(INTEGRATION_COMMERCE_CODE),
    });
    expect(withIntegrationCode.join(" ")).toContain("integración");
  });

  it("devuelve TODOS los motivos, no el primero", () => {
    const blockers = productionBlockers({
      ...GOOD,
      productionEnabled: false,
      nodeEnv: "development",
      commerceCode: undefined,
      siteUrl: "http://localhost:3000",
    });
    expect(blockers.length).toBeGreaterThanOrEqual(5);
  });

  it("reconoce una credencial de integración por su prefijo", () => {
    expect(looksLikeIntegrationCredential("597055555532", undefined)).toBe(true);
    expect(looksLikeIntegrationCredential("597055555584", undefined)).toBe(true);
    expect(looksLikeIntegrationCredential("597000000001", "llave-real")).toBe(false);
  });
});

describe("URL del sitio", () => {
  it("acepta un dominio público con HTTPS", () => {
    expect(siteUrlBlockers("https://hagotufila.cl")).toEqual([]);
  });

  it("rechaza lo que no sirve para una URL de retorno productiva", () => {
    expect(siteUrlBlockers("no-es-una-url").length).toBeGreaterThan(0);
    expect(siteUrlBlockers("http://hagotufila.cl").length).toBeGreaterThan(0);
    expect(siteUrlBlockers("https://127.0.0.1").length).toBeGreaterThan(0);
    expect(siteUrlBlockers("https://intranet").length).toBeGreaterThan(0);
  });
});

describe("destino de la redirección", () => {
  it("acepta solo el dominio del ambiente correspondiente", () => {
    expect(
      isTrustedRedirect("https://webpay3gint.transbank.cl/webpayserver/initTransaction", "integration"),
    ).toBe(true);
    expect(
      isTrustedRedirect("https://webpay3g.transbank.cl/webpayserver/initTransaction", "production"),
    ).toBe(true);
  });

  it("no acepta el dominio del OTRO ambiente", () => {
    expect(
      isTrustedRedirect("https://webpay3g.transbank.cl/webpayserver/initTransaction", "integration"),
    ).toBe(false);
    expect(
      isTrustedRedirect("https://webpay3gint.transbank.cl/webpayserver/initTransaction", "production"),
    ).toBe(false);
  });

  it("rechaza cualquier otro destino", () => {
    for (const url of [
      "https://webpay3gint.transbank.cl.atacante.com/pagar",
      "https://atacante.com/webpay3gint.transbank.cl",
      "http://webpay3gint.transbank.cl/webpayserver/initTransaction",
      "javascript:alert(1)",
      "no-es-una-url",
      "",
    ]) {
      expect(isTrustedRedirect(url, "integration")).toBe(false);
    }
  });
});
