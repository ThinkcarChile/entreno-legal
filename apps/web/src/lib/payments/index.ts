import { env, resolveDataSource } from "@/lib/env";

import { DelayedMockPaymentProvider } from "./delayed-mock-provider";
import { MockPaymentProvider } from "./mock-provider";
import {
  INTEGRATION_API_KEY,
  INTEGRATION_COMMERCE_CODE,
  productionBlockers,
  type GuardContext,
} from "./transbank/config";
import { TransbankPaymentProvider } from "./transbank/provider";

import type { PaymentProvider } from "./provider";

export * from "./provider";
export * from "./settlement";
export * from "./settle";
export { TransbankPaymentProvider } from "./transbank/provider";
export { MockPaymentProvider } from "./mock-provider";
export { DelayedMockPaymentProvider } from "./delayed-mock-provider";
export * from "./transbank/config";
export * from "./transbank/identifiers";
export * from "./transbank/return-flow";
export * from "./transbank/mapping";
export * from "./transbank/sanitize";

let provider: PaymentProvider | null = null;

/**
 * Contexto que ven las guardas de producción.
 *
 * Se arma en un solo sitio para que la decisión de «¿puede esto cobrar de
 * verdad?» dependa siempre de las mismas señales, las lea quien las lea: el
 * proveedor al construirse, el verificador, o la pantalla de administración.
 */
export function transbankGuardContext(): GuardContext {
  return {
    environment: env.TRANSBANK_ENVIRONMENT,
    productionEnabled: env.TRANSBANK_PRODUCTION_ENABLED,
    commerceCode: env.TRANSBANK_PRODUCTION_COMMERCE_CODE,
    apiKeySecret: env.TRANSBANK_PRODUCTION_API_KEY_SECRET,
    siteUrl: env.NEXT_PUBLIC_SITE_URL,
    nodeEnv: env.NODE_ENV,
    demoMode: resolveDataSource() === "demo",
    selectedProvider: env.PAYMENT_PROVIDER,
  };
}

/**
 * Resolución del proveedor de pago. Único lugar donde se decide cuál se usa.
 *
 * Tres proveedores y una sola forma de elegir:
 *
 * · `mock` y `mock-delayed` — desarrollo y pruebas de carrera. Prohibidos en
 *   producción sin excepción, y no hay variable que los levante allí.
 * · `transbank` en integración — credenciales públicas de Transbank, tomadas
 *   del SDK. No se configuran ni se guardan: así nadie las confunde con las
 *   de verdad.
 * · `transbank` en producción — credenciales del hosting, y además
 *   `TRANSBANK_PRODUCTION_ENABLED=true`. Si falta cualquiera de las dos cosas,
 *   o si la configuración es ambigua, esto **lanza**: la aplicación no arranca
 *   a medias hacia un ambiente donde el dinero es real.
 */
export function getPaymentProvider(): PaymentProvider {
  if (provider) return provider;

  if (env.PAYMENT_PROVIDER === "transbank") {
    const guards = transbankGuardContext();
    const production = env.TRANSBANK_ENVIRONMENT === "production";

    if (production) {
      const blockers = productionBlockers(guards);
      if (blockers.length > 0) {
        throw new Error(
          "Webpay Plus productivo está desactivado y no se construye el proveedor. Motivos: " +
            blockers.join("; ") +
            ".",
        );
      }
    }

    provider = new TransbankPaymentProvider(
      {
        environment: env.TRANSBANK_ENVIRONMENT,
        commerceCode: production
          ? (env.TRANSBANK_PRODUCTION_COMMERCE_CODE ?? "")
          : String(INTEGRATION_COMMERCE_CODE),
        apiKey: production
          ? (env.TRANSBANK_PRODUCTION_API_KEY_SECRET ?? "")
          : String(INTEGRATION_API_KEY),
        returnUrl: `${env.NEXT_PUBLIC_SITE_URL}/pagos/retorno`,
      },
      guards,
    );
    return provider;
  }

  // Los dos simulados —inmediato y retardado— quedan fuera de producción sin
  // excepción. No hay variable de entorno que lo levante.
  if (env.NODE_ENV === "production") {
    throw new Error(
      `PAYMENT_PROVIDER=${env.PAYMENT_PROVIDER} no está permitido en producción. Configura Transbank.`,
    );
  }

  provider =
    env.PAYMENT_PROVIDER === "mock-delayed"
      ? new DelayedMockPaymentProvider()
      : new MockPaymentProvider();
  return provider;
}

export function setPaymentProvider(next: PaymentProvider | null): void {
  provider = next;
}

/** ¿El proveedor activo cobra de verdad? Para avisos en pantalla y registros. */
export function isLivePaymentProvider(): boolean {
  return env.PAYMENT_PROVIDER === "transbank" && env.TRANSBANK_ENVIRONMENT === "production";
}
