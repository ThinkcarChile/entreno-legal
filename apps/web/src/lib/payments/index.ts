import { env, resolveDataSource, transbankEnvironmentExplicit } from "@/lib/env";

import { DelayedMockPaymentProvider } from "./delayed-mock-provider";
import { MockPaymentProvider } from "./mock-provider";
import {
  environmentBlockers,
  environmentNotices,
  INTEGRATION_API_KEY,
  INTEGRATION_COMMERCE_CODE,
  productionBlockers,
  TransbankEnvironmentBlockedError,
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
let existingProvider: PaymentProvider | null = null;
/** Proveedor puesto a mano (pruebas): manda en las dos puertas. */
let injected = false;

/**
 * Contexto que ven las guardas de producción.
 *
 * Se arma en un solo sitio para que la decisión de «¿puede esto cobrar de
 * verdad?» dependa siempre de las mismas señales, las lea quien las lea: el
 * proveedor al construirse, el verificador, o la pantalla de administración.
 */
export function transbankGuardContext(scope: "new" | "existing" = "new"): GuardContext {
  return {
    scope,
    environment: env.TRANSBANK_ENVIRONMENT,
    environmentExplicit: transbankEnvironmentExplicit,
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
  provider = buildPaymentProvider("new");
  return provider;
}

/**
 * Proveedor para CERRAR pagos que ya existen: retorno, conciliación y
 * devoluciones.
 *
 * Exige las mismas guardas que `getPaymentProvider` salvo el interruptor
 * `TRANSBANK_PRODUCTION_ENABLED`. Así, apagar el interruptor —el primer paso
 * del rollback en docs/TRANSBANK.md §9— detiene los cobros nuevos y deja que
 * los pagos en vuelo se confirmen, se concilien y se devuelvan. Antes, con el
 * interruptor apagado no se construía ningún proveedor y el dinero que ya
 * había entrado no se podía cerrar ni devolver.
 *
 * Esta instancia se niega a abrir pagos nuevos (`createPayment`).
 */
export function getPaymentProviderForExistingPayments(): PaymentProvider {
  // Los simulados guardan estado en memoria: las dos puertas comparten la misma
  // instancia. Y uno inyectado en pruebas manda en ambas.
  if (injected || env.PAYMENT_PROVIDER !== "transbank") return getPaymentProvider();
  if (existingProvider) return existingProvider;
  existingProvider = buildPaymentProvider("existing");
  return existingProvider;
}

function buildPaymentProvider(scope: "new" | "existing"): PaymentProvider {
  if (env.PAYMENT_PROVIDER === "transbank") {
    const guards = transbankGuardContext(scope);
    const production = env.TRANSBANK_ENVIRONMENT === "production";

    // Primero, que alguien haya elegido el ambiente: con NODE_ENV=production y
    // TRANSBANK_ENVIRONMENT sin escribir no se construye nada, ni siquiera
    // integración. Antes se tomaba integración en silencio.
    const unset = environmentBlockers(guards);
    if (unset.length > 0) throw new TransbankEnvironmentBlockedError(unset);

    // Integración escrita a mano en producción vale (un despliegue de
    // pruebas), pero queda dicho en el registro del servidor.
    for (const notice of environmentNotices(guards)) console.warn(`[pagos] ${notice}`);

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

    return new TransbankPaymentProvider(
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
  }

  // Los dos simulados —inmediato y retardado— quedan fuera de producción sin
  // excepción. No hay variable de entorno que lo levante.
  if (env.NODE_ENV === "production") {
    throw new Error(
      `PAYMENT_PROVIDER=${env.PAYMENT_PROVIDER} no está permitido en producción. Configura Transbank.`,
    );
  }

  return env.PAYMENT_PROVIDER === "mock-delayed"
    ? new DelayedMockPaymentProvider()
    : new MockPaymentProvider();
}

export function setPaymentProvider(next: PaymentProvider | null): void {
  provider = next;
  existingProvider = null;
  injected = next !== null;
}

/** ¿El proveedor activo cobra de verdad? Para avisos en pantalla y registros. */
export function isLivePaymentProvider(): boolean {
  return env.PAYMENT_PROVIDER === "transbank" && env.TRANSBANK_ENVIRONMENT === "production";
}
