import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cronSecretState,
  isExplicitTransbankEnvironment,
  parseServerEnv,
  type RawServerEnv,
} from "./env";
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

describe("CRON_SECRET", () => {
  const LARGO = "a".repeat(64);

  it("uno demasiado corto no tumba la aplicación entera", () => {
    // Antes: «Variables de entorno inválidas» en todas las páginas.
    expect(() => parseServerEnv({ CRON_SECRET: "corto-de-20-caracter" })).not.toThrow();
    expect(parseServerEnv({ CRON_SECRET: "corto-de-20-caracter" }).CRON_SECRET).toBe(
      "corto-de-20-caracter",
    );
  });

  it("la ruta que lo usa lo rechaza y sabe por qué", () => {
    expect(cronSecretState("corto-de-20-caracter")).toEqual({ ok: false, reason: "too_short" });
    expect(cronSecretState("a".repeat(31))).toEqual({ ok: false, reason: "too_short" });
  });

  it("ausente o vacío es «no configurado», no «corto»", () => {
    expect(cronSecretState(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(cronSecretState("   ")).toEqual({ ok: false, reason: "missing" });
    expect(cronSecretState(parseServerEnv({ CRON_SECRET: "" }).CRON_SECRET)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("con 32 caracteres o más sirve, sin los espacios de los extremos", () => {
    expect(cronSecretState("a".repeat(32))).toEqual({ ok: true, secret: "a".repeat(32) });
    expect(cronSecretState(`  ${LARGO}\n`)).toEqual({ ok: true, secret: LARGO });
  });
});

describe(".env.example", () => {
  /** Las líneas `CLAVE=valor` sin comentar, como las cargaría quien la copie. */
  function template(): RawServerEnv {
    const text = readFileSync(resolve(__dirname, "../../.env.example"), "utf8");
    const raw: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) raw[match[1]] = match[2];
    }
    return raw as RawServerEnv;
  }

  it("se carga tal cual sin tumbar la aplicación", () => {
    expect(() => parseServerEnv(template())).not.toThrow();
  });

  it("no escribe TRANSBANK_ENVIRONMENT: copiada a producción, Webpay se niega a operar", () => {
    // Traía `TRANSBANK_ENVIRONMENT=integration` escrito: el ambiente contaba
    // como elegido y producción operaba en integración con solo un aviso.
    const raw = template();
    expect(raw.TRANSBANK_ENVIRONMENT).toBeUndefined();
    const context = guardContextFrom({
      ...raw,
      NODE_ENV: "production",
      PAYMENT_PROVIDER: "transbank",
    });
    expect(environmentBlockers(context).join(" ")).toContain("falta TRANSBANK_ENVIRONMENT");
  });
});
