import { describe, expect, it } from "vitest";

import {
  INTEGRATION_API_KEY,
  INTEGRATION_COMMERCE_CODE,
  environmentBlockers,
  environmentNotices,
  isTrustedRedirect,
  looksLikeIntegrationCredential,
  productionBlockers,
  siteUrlBlockers,
  type GuardContext,
} from "./config";

/** Una configuración productiva impecable. Cada prueba rompe UNA cosa. */
const GOOD: GuardContext = {
  environment: "production",
  environmentExplicit: true,
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

describe("ámbito de las guardas: pagos nuevos y pagos existentes", () => {
  const apagado = { ...GOOD, productionEnabled: false };

  it("con el interruptor apagado no se abren pagos nuevos", () => {
    expect(productionBlockers(apagado)).toContain("falta TRANSBANK_PRODUCTION_ENABLED=true");
    expect(productionBlockers({ ...apagado, scope: "new" })).toContain(
      "falta TRANSBANK_PRODUCTION_ENABLED=true",
    );
  });

  it("pero los existentes se siguen cerrando: retorno, conciliación y devoluciones", () => {
    expect(productionBlockers({ ...apagado, scope: "existing" })).toEqual([]);
  });

  it.each([
    ["credenciales de integración", { commerceCode: String(INTEGRATION_COMMERCE_CODE) }],
    ["modo demostración", { demoMode: true }],
    ["NODE_ENV que no es production", { nodeEnv: "development" }],
    ["URL sin HTTPS", { siteUrl: "http://hagotufila.cl" }],
    ["sin llave", { apiKeySecret: undefined }],
  ])("el ámbito de existentes NO relaja %s", (_label, patch) => {
    expect(productionBlockers({ ...apagado, scope: "existing", ...patch }).length).toBeGreaterThan(0);
  });
});

describe("el ambiente no se toma por omisión en producción", () => {
  /**
   * El despliegue del defecto: NODE_ENV=production, PAYMENT_PROVIDER=transbank
   * y TRANSBANK_ENVIRONMENT sin escribir. El ambiente efectivo es integración,
   * pero nadie lo eligió.
   */
  const SIN_AMBIENTE: GuardContext = {
    environment: "integration",
    environmentExplicit: false,
    productionEnabled: false,
    siteUrl: "https://hagotufila.cl",
    nodeEnv: "production",
    demoMode: false,
    selectedProvider: "transbank",
  };

  it("sin TRANSBANK_ENVIRONMENT, Webpay no opera ni en integración, y dice por qué", () => {
    const blockers = environmentBlockers(SIN_AMBIENTE);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("falta TRANSBANK_ENVIRONMENT");
    expect(blockers[0]).toContain("no se toma integración por omisión");
  });

  it("vale también para cerrar pagos existentes", () => {
    expect(environmentBlockers({ ...SIN_AMBIENTE, scope: "existing" })).toHaveLength(1);
  });

  it("y producción lo cuenta entre sus motivos", () => {
    const blockers = productionBlockers({ ...GOOD, environmentExplicit: false });
    expect(blockers.join(" ")).toContain("falta TRANSBANK_ENVIRONMENT");
  });

  it("integración escrita a mano en producción opera —un despliegue de pruebas—, pero se avisa", () => {
    const staging = { ...SIN_AMBIENTE, environmentExplicit: true };
    expect(environmentBlockers(staging)).toEqual([]);
    expect(environmentNotices(staging)).toHaveLength(1);
    expect(environmentNotices(staging)[0]).toContain("INTEGRACIÓN con NODE_ENV=production");
  });

  it("fuera de producción, integración por omisión sigue siendo lo normal y no avisa", () => {
    for (const nodeEnv of ["development", "test"]) {
      const local = { ...SIN_AMBIENTE, nodeEnv };
      expect(environmentBlockers(local)).toEqual([]);
      expect(environmentNotices(local)).toEqual([]);
    }
  });

  it("con un proveedor simulado no aplica: ese ya lo prohíbe producción por su cuenta", () => {
    expect(environmentBlockers({ ...SIN_AMBIENTE, selectedProvider: "mock" })).toEqual([]);
  });

  it("producción escrita y completa no bloquea ni avisa", () => {
    expect(environmentBlockers(GOOD)).toEqual([]);
    expect(environmentNotices(GOOD)).toEqual([]);
  });
});

describe("integración con el interruptor de producción encendido", () => {
  /**
   * El hosting de producción armado sobre `.env.example`, que traía
   * `TRANSBANK_ENVIRONMENT=integration` escrito: el ambiente es explícito, así
   * que la guarda de «falta el ambiente» no salta, y con el interruptor
   * encendido alguien quiso cobrar de verdad.
   */
  const CONTRADICTORIA: GuardContext = {
    ...GOOD,
    environment: "integration",
    environmentExplicit: true,
    productionEnabled: true,
  };

  it("se niega a operar y dice cómo salir", () => {
    const blockers = environmentBlockers(CONTRADICTORIA);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("TRANSBANK_PRODUCTION_ENABLED=true con TRANSBANK_ENVIRONMENT=integration");
    expect(blockers[0]).toContain('escribe "production"');
  });

  it("también al cerrar pagos existentes: la configuración hay que arreglarla igual", () => {
    expect(environmentBlockers({ ...CONTRADICTORIA, scope: "existing" })).toHaveLength(1);
  });

  it("con el interruptor apagado es un despliegue de pruebas: opera y avisa", () => {
    const staging = { ...CONTRADICTORIA, productionEnabled: false };
    expect(environmentBlockers(staging)).toEqual([]);
    expect(environmentNotices(staging)).toHaveLength(1);
  });

  it("volver atrás desde producción (ambiente production, interruptor apagado) no bloquea aquí", () => {
    expect(environmentBlockers({ ...GOOD, productionEnabled: false })).toEqual([]);
  });

  it("fuera de producción, o con otro proveedor, no aplica", () => {
    expect(environmentBlockers({ ...CONTRADICTORIA, nodeEnv: "development" })).toEqual([]);
    expect(environmentBlockers({ ...CONTRADICTORIA, selectedProvider: "mock" })).toEqual([]);
  });
});
