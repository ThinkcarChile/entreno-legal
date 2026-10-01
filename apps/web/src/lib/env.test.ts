import { describe, expect, it } from "vitest";

import { isExplicitTransbankEnvironment, parseServerEnv, type RawServerEnv } from "./env";
import { environmentBlockers, type GuardContext } from "./payments/transbank/config";

/**
 * El contexto de las guardas tal como lo arma `payments/index.ts` a partir de
 * las variables: aquí se prueba la cadena entera, desde el entorno hasta la
 * negativa a operar.
 */
function guardContextFrom(raw: RawServerEnv): GuardContext {
  const env = parseServerEnv(raw);
  return {
    environment: env.TRANSBANK_ENVIRONMENT,
    environmentExplicit: isExplicitTransbankEnvironment(raw.TRANSBANK_ENVIRONMENT),
    productionEnabled: env.TRANSBANK_PRODUCTION_ENABLED,
    siteUrl: env.NEXT_PUBLIC_SITE_URL,
    nodeEnv: env.NODE_ENV,
    demoMode: false,
    selectedProvider: env.PAYMENT_PROVIDER,
  };
}

describe("TRANSBANK_ENVIRONMENT", () => {
  it("fuera de producción, si falta, es integración", () => {
    expect(parseServerEnv({}).TRANSBANK_ENVIRONMENT).toBe("integration");
    expect(environmentBlockers(guardContextFrom({ PAYMENT_PROVIDER: "transbank" }))).toEqual([]);
  });

  it("vacía cuenta como ausente, igual que el resto de variables", () => {
    expect(parseServerEnv({ TRANSBANK_ENVIRONMENT: "  " }).TRANSBANK_ENVIRONMENT).toBe("integration");
    expect(isExplicitTransbankEnvironment("  ")).toBe(false);
    expect(isExplicitTransbankEnvironment(undefined)).toBe(false);
  });

  it("escrita, se reconoce como elegida", () => {
    expect(isExplicitTransbankEnvironment("integration")).toBe(true);
    expect(isExplicitTransbankEnvironment("production")).toBe(true);
  });

  it("con NODE_ENV=production y Webpay, si falta, las guardas se niegan con el motivo", () => {
    const context = guardContextFrom({ NODE_ENV: "production", PAYMENT_PROVIDER: "transbank" });
    expect(context.environment).toBe("integration");
    expect(environmentBlockers(context).join(" ")).toContain("falta TRANSBANK_ENVIRONMENT");
  });

  it("con NODE_ENV=production, integración escrita a mano sí opera (despliegue de pruebas)", () => {
    const context = guardContextFrom({
      NODE_ENV: "production",
      PAYMENT_PROVIDER: "transbank",
      TRANSBANK_ENVIRONMENT: "integration",
    });
    expect(context.environmentExplicit).toBe(true);
    expect(environmentBlockers(context)).toEqual([]);
  });

  it("un valor que no es un ambiente no arranca", () => {
    expect(() => parseServerEnv({ TRANSBANK_ENVIRONMENT: "prod" })).toThrow(/TRANSBANK_ENVIRONMENT/);
  });
});
