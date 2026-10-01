import { describe, expect, it } from "vitest";

import { PaymentProviderError } from "../provider";
import { TransbankPaymentProvider } from "./provider";

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
    await expect(
      provider.createPayment({
        paymentId: "pago-1",
        jobId: "trabajo-1",
        reference: "HTF-0001",
        amount: { amount: 15000, currency: "CLP" },
        returnUrl: "https://hagotufila.cl/pagos/retorno",
        sessionId: "sesion-1",
        buyOrder: "HTF0001ABCDEF",
      } as Parameters<TransbankPaymentProvider["createPayment"]>[0]),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });
});
