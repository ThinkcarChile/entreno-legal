import { env } from "@/lib/env";

import { DelayedMockPaymentProvider } from "./delayed-mock-provider";
import { MockPaymentProvider } from "./mock-provider";
import { TransbankPaymentProvider } from "./transbank-provider";

import type { PaymentProvider } from "./provider";

export * from "./provider";
export * from "./settlement";
export * from "./settle";
export { TransbankPaymentProvider } from "./transbank-provider";
export { MockPaymentProvider } from "./mock-provider";
export { DelayedMockPaymentProvider } from "./delayed-mock-provider";

let provider: PaymentProvider | null = null;

/**
 * Resolución del proveedor de pago. Único lugar donde se decide cuál se usa.
 * El proveedor simulado queda prohibido en producción.
 */
export function getPaymentProvider(): PaymentProvider {
  if (provider) return provider;

  if (env.PAYMENT_PROVIDER === "transbank") {
    provider = new TransbankPaymentProvider({
      environment: env.TRANSBANK_ENVIRONMENT,
      commerceCode: env.TRANSBANK_COMMERCE_CODE,
      apiKey: env.TRANSBANK_API_KEY,
    });
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
