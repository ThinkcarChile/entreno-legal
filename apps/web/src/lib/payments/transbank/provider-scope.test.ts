import { describe, expect, it } from "vitest";

import { PaymentProviderError } from "../provider";
import { INTEGRATION_API_KEY, INTEGRATION_COMMERCE_CODE } from "./config";
import { TransbankPaymentProvider } from "./provider";

const CREATE_INPUT = {
  paymentId: "pago-1",
  jobId: "trabajo-1",
  reference: "HTF-0001",
  amount: { amount: 15000, currency: "CLP" },
  returnUrl: "https://hagotufila.cl/pagos/retorno",
  sessionId: "sesion-1",
  buyOrder: "HTF0001ABCDEF",
} as Parameters<TransbankPaymentProvider["createPayment"]>[0];

/**
 * Una instancia para cerrar pagos existentes no abre pagos nuevos.
 *
 * Es la que sigue operando con `TRANSBANK_PRODUCTION_ENABLED` apagado: si
 * pudiera crear transacciones, apagar el interruptor no detendría los cobros.
 */
describe("TransbankPaymentProvider con ámbito de pagos existentes", () => {
  const provider = new TransbankPaymentProvider(
    {
      environment: "production",
      commerceCode: "597000000001",
      apiKey: "una-llave-productiva-de-verdad-larga",
      returnUrl: "https://hagotufila.cl/pagos/retorno",
    },
    {
      environment: "production",
      environmentExplicit: true,
      productionEnabled: false,
      commerceCode: "597000000001",
      apiKeySecret: "una-llave-productiva-de-verdad-larga",
      siteUrl: "https://hagotufila.cl",
      nodeEnv: "production",
      demoMode: false,
      selectedProvider: "transbank",
      scope: "existing",
    },
  );

  it("se niega a crear una transacción, antes de tocar la red", async () => {
    await expect(provider.createPayment(CREATE_INPUT)).rejects.toBeInstanceOf(PaymentProviderError);
  });
});

/**
 * El despliegue del defecto: NODE_ENV=production, PAYMENT_PROVIDER=transbank
 * y TRANSBANK_ENVIRONMENT sin escribir. El proveedor que se armaba era el de
 * integración, con sus credenciales públicas, y operaba.
 *
 * Ahora no llega a construir el cliente del SDK: el error dice el motivo, y no
 * es uno de red —si lo fuera, la petición habría salido—.
 */
describe("TransbankPaymentProvider de integración sin ambiente elegido en producción", () => {
  const provider = new TransbankPaymentProvider(
    {
      environment: "integration",
      commerceCode: String(INTEGRATION_COMMERCE_CODE),
      apiKey: String(INTEGRATION_API_KEY),
      returnUrl: "https://hagotufila.cl/pagos/retorno",
    },
    {
      environment: "integration",
      environmentExplicit: false,
      productionEnabled: false,
      siteUrl: "https://hagotufila.cl",
      nodeEnv: "production",
      demoMode: false,
      selectedProvider: "transbank",
    },
  );

  it("no abre un pago: falta TRANSBANK_ENVIRONMENT", async () => {
    const attempt = provider.createPayment(CREATE_INPUT);
    await expect(attempt).rejects.toBeInstanceOf(PaymentProviderError);
    await expect(attempt).rejects.toThrow(/falta TRANSBANK_ENVIRONMENT/);
  });

  it("ni confirma uno: tampoco sabría contra qué ambiente", async () => {
    await expect(provider.confirmPayment({ token: "token-de-prueba" })).rejects.toThrow(
      /falta TRANSBANK_ENVIRONMENT/,
    );
  });
});
