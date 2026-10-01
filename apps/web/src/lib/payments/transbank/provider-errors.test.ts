import { describe, expect, it } from "vitest";

import { PaymentProviderError } from "../provider";
import { TransbankPaymentProvider, sdkFailureDetails } from "./provider";

/**
 * Cómo falló una llamada a Transbank: si la petición salió y con qué código
 * contestó.
 *
 * Para una devolución es la diferencia entre «no se devolvió nada» y «puede que
 * se haya devuelto». El SDK envuelve todo fallo de red o HTTP en un
 * `TransbankError` cuyo mensaje empieza por el error de axios convertido a
 * texto; los errores se construyen aquí con esa misma forma (comprobada contra
 * `transbank-sdk` 6.1.1 y axios 1.x), sin red.
 */

function transbankError(firstLine: string): Error {
  const error = new Error(`${firstLine}\nmensaje del banco\n`);
  error.name = "TransbankError";
  return error;
}

describe("sdkFailureDetails", () => {
  it("un 4xx salió y el banco contestó", () => {
    const line = "AxiosError: Request failed with status code 422";
    expect(sdkFailureDetails(transbankError(line), line)).toEqual({ requestSent: true, httpStatus: 422 });
  });

  it("un tiempo agotado salió, sin código", () => {
    const line = "AxiosError: timeout of 600000ms exceeded";
    expect(sdkFailureDetails(transbankError(line), line)).toEqual({ requestSent: true, httpStatus: null });
  });

  it("lo que no viene del SDK no llegó a salir", () => {
    const line = "'token' can't be null or white space";
    expect(sdkFailureDetails(new Error(line), line)).toEqual({ requestSent: false, httpStatus: null });
  });
});

describe("TransbankPaymentProvider.refundTransaction ante un fallo del SDK", () => {
  function providerWith(refund: () => Promise<unknown>): TransbankPaymentProvider {
    const provider = new TransbankPaymentProvider(
      {
        environment: "integration",
        commerceCode: "597055555532",
        apiKey: "llave-de-integracion",
        returnUrl: "http://localhost:3000/pagos/retorno",
      },
      {
        environment: "integration",
        environmentExplicit: true,
        productionEnabled: false,
        siteUrl: "http://localhost:3000",
        nodeEnv: "test",
        demoMode: false,
        selectedProvider: "transbank",
        scope: "existing",
      },
    );
    // El cliente del SDK, sustituido: ninguna petición sale de la prueba.
    (provider as unknown as { transaction: unknown }).transaction = { refund };
    return provider;
  }

  const input = {
    providerTransactionId: "tok",
    token: "tok",
    amount: { amount: 5000, currency: "CLP" as const },
  };

  it("un 422 sale como rechazo con su código, sin la credencial", async () => {
    const provider = providerWith(async () => {
      throw transbankError("AxiosError: Request failed with status code 422");
    });

    const error = await provider.refundTransaction(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ requestSent: true, httpStatus: 422 });
    expect((error as Error).message).not.toContain("llave-de-integracion");
  });

  it("un tiempo agotado sale como enviado y sin código", async () => {
    const provider = providerWith(async () => {
      throw transbankError("AxiosError: timeout of 600000ms exceeded");
    });

    await expect(provider.refundTransaction(input)).rejects.toMatchObject({
      requestSent: true,
      httpStatus: null,
    });
  });

  it("un importe inválido no llega a salir", async () => {
    const provider = providerWith(async () => ({}));

    await expect(
      provider.refundTransaction({ ...input, amount: { amount: 0, currency: "CLP" } }),
    ).rejects.toMatchObject({ requestSent: false });
  });
});
