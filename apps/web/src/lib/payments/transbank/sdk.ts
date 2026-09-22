import * as transbankSdk from "transbank-sdk";

/**
 * Acceso portable al SDK oficial.
 *
 * `transbank-sdk` 6.1.1 no declara `exports` en su `package.json`: publica
 * `main` en CommonJS (`dist/es5`) y `module` en ESM (`dist/es6`). El resultado
 * es que un `import { WebpayPlus } from "transbank-sdk"` funciona dentro del
 * empaquetador de Next —que resuelve `module`— y **falla en Node puro**, que
 * resuelve `main` y no expone exportaciones con nombre desde un módulo
 * CommonJS.
 *
 * Eso importa porque el verificador y los guiones de prueba corren en Node
 * suelto: si el proveedor solo funcionara dentro de Next, lo que se verifica
 * no sería lo que se ejecuta.
 *
 * Aquí se resuelven las dos formas una sola vez, y el resto del código importa
 * de este archivo.
 */
interface TransbankNamespace {
  WebpayPlus: {
    Transaction: {
      buildForIntegration(commerceCode: string, apiKey: string): TransbankTransactionClient;
      buildForProduction(commerceCode: string, apiKey: string): TransbankTransactionClient;
    };
  };
  IntegrationCommerceCodes: Record<string, string>;
  IntegrationApiKeys: Record<string, string>;
}

/**
 * Los cuatro métodos que se usan.
 *
 * El SDK los declara como `Promise<any>`: las respuestas de Webpay no vienen
 * tipadas. Por eso el mapeo a algo comprobable vive en `mapping.ts`, y aquí
 * solo se declara la forma de la llamada.
 */
export interface TransbankTransactionClient {
  create(
    buyOrder: string,
    sessionId: string,
    amount: number,
    returnUrl: string,
  ): Promise<unknown>;
  commit(token: string): Promise<unknown>;
  status(token: string): Promise<unknown>;
  refund(token: string, amount: number): Promise<unknown>;
}

const resolved = ((transbankSdk as unknown as { default?: TransbankNamespace }).default ??
  (transbankSdk as unknown as TransbankNamespace)) as TransbankNamespace;

export const WebpayPlus = resolved.WebpayPlus;
export const IntegrationCommerceCodes = resolved.IntegrationCommerceCodes;
export const IntegrationApiKeys = resolved.IntegrationApiKeys;
