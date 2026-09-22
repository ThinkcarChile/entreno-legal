import { IntegrationApiKeys, IntegrationCommerceCodes } from "./sdk";

/**
 * Configuración de Webpay Plus y las guardas que impiden cobrar de verdad
 * por accidente.
 *
 * La regla de fondo: **una configuración ambigua no arranca**. Es preferible
 * que la aplicación se niegue a operar a que cobre a alguien con credenciales
 * de integración, o peor, que cobre de verdad creyendo que está probando.
 */

export type TransbankEnvironment = "integration" | "production" | "mock";

/** URLs oficiales de cada ambiente, para validar adónde se redirige. */
export const TRANSBANK_HOSTS: Record<string, string> = {
  integration: "webpay3gint.transbank.cl",
  production: "webpay3g.transbank.cl",
};

/**
 * Credenciales públicas del ambiente de integración.
 *
 * Las publica Transbank en su documentación y las trae el propio SDK. No son
 * secretas y no deben tratarse como tales: están aquí para que nadie las meta
 * en un `.env` y luego las confunda con las de producción.
 */
export const INTEGRATION_COMMERCE_CODE = IntegrationCommerceCodes.WEBPAY_PLUS;
export const INTEGRATION_API_KEY = IntegrationApiKeys.WEBPAY;

export interface TransbankSettings {
  /** El proveedor real nunca se construye con "mock". */
  environment: "integration" | "production";
  commerceCode: string;
  apiKey: string;
  returnUrl: string;
}

export interface GuardContext {
  environment: "integration" | "production";
  /** `TRANSBANK_PRODUCTION_ENABLED`. Sin esto, producción no opera. */
  productionEnabled: boolean;
  commerceCode?: string;
  apiKeySecret?: string;
  siteUrl: string;
  nodeEnv: string;
  /** `true` si la aplicación corre contra datos de demostración. */
  demoMode: boolean;
  /** Proveedor seleccionado en `PAYMENT_PROVIDER`. */
  selectedProvider: string;
}

/**
 * ¿Una credencial es en realidad la de integración?
 *
 * Es el error más caro de todos en la otra dirección: creer que se está
 * cobrando cuando se está en integración. Y también protege del inverso, que
 * alguien pegue la clave pública de integración en la variable de producción.
 */
export function looksLikeIntegrationCredential(
  commerceCode: string | undefined,
  apiKey: string | undefined,
): boolean {
  if (apiKey && apiKey.trim() === String(INTEGRATION_API_KEY)) return true;
  const code = commerceCode?.trim() ?? "";
  // Todos los comercios de integración de Transbank empiezan por 5970555555.
  return code.startsWith("5970555555");
}

/**
 * Las razones por las que el proveedor productivo se niega a operar.
 *
 * Devuelve la lista completa, no la primera: quien configura el hosting
 * necesita verlas todas de una vez, no descubrirlas de una en una.
 */
export function productionBlockers(context: GuardContext): string[] {
  const blockers: string[] = [];

  if (context.environment !== "production") {
    blockers.push("TRANSBANK_ENVIRONMENT no es exactamente \"production\"");
  }
  if (!context.productionEnabled) {
    blockers.push("falta TRANSBANK_PRODUCTION_ENABLED=true");
  }
  if (context.nodeEnv !== "production") {
    blockers.push(`NODE_ENV es "${context.nodeEnv}" y no "production"`);
  }
  if (!context.commerceCode) {
    blockers.push("falta TRANSBANK_PRODUCTION_COMMERCE_CODE");
  }
  if (!context.apiKeySecret) {
    blockers.push("falta TRANSBANK_PRODUCTION_API_KEY_SECRET");
  }
  if (looksLikeIntegrationCredential(context.commerceCode, context.apiKeySecret)) {
    blockers.push("las credenciales productivas son en realidad las de integración");
  }
  if (context.demoMode) {
    blockers.push("la aplicación está en modo demostración");
  }
  if (context.selectedProvider !== "transbank") {
    blockers.push(`PAYMENT_PROVIDER es "${context.selectedProvider}" y no "transbank"`);
  }

  blockers.push(...siteUrlBlockers(context.siteUrl));
  return blockers;
}

/** Comprobaciones sobre `NEXT_PUBLIC_SITE_URL`, que define la URL de retorno. */
export function siteUrlBlockers(siteUrl: string): string[] {
  const blockers: string[] = [];
  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    return [`NEXT_PUBLIC_SITE_URL no es una URL válida: ${siteUrl}`];
  }

  if (url.protocol !== "https:") {
    blockers.push("NEXT_PUBLIC_SITE_URL no usa HTTPS");
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
    blockers.push("NEXT_PUBLIC_SITE_URL apunta a localhost");
  }
  if (url.port) {
    blockers.push(`NEXT_PUBLIC_SITE_URL lleva un puerto local (${url.port})`);
  }
  if (!url.hostname.includes(".")) {
    blockers.push("NEXT_PUBLIC_SITE_URL no tiene un dominio público");
  }
  return blockers;
}

/**
 * La URL a la que Webpay dice que hay que redirigir tiene que ser suya.
 *
 * Es el único dato de la respuesta que se usa para mover el navegador de una
 * persona. Si algún día esa respuesta llegara manipulada, este control impide
 * que el formulario de pago se envíe a otro sitio con el token dentro.
 */
export function isTrustedRedirect(url: string, environment: TransbankEnvironment): boolean {
  const expected = TRANSBANK_HOSTS[environment];
  if (!expected) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname === expected;
}

export class TransbankProductionBlockedError extends Error {
  /**
   * Los motivos, por separado, para poder listarlos en una pantalla.
   *
   * Se declara como campo y no como propiedad de parámetro porque el
   * verificador corre con el despojado de tipos de Node, que no admite esa
   * sintaxis: lo que se verifica tiene que poder ejecutarse igual que lo que
   * se despliega.
   */
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super("Webpay Plus productivo está desactivado. Motivos: " + blockers.join("; ") + ".");
    this.name = "TransbankProductionBlockedError";
    this.blockers = blockers;
  }
}
