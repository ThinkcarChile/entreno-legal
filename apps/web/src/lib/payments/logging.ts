import { randomUUID } from "node:crypto";

import { maskToken, scrub } from "./transbank/sanitize";

/**
 * Registro estructurado de las operaciones de dinero.
 *
 * Una línea JSON por operación, con lo justo para reconstruir un caso y sin
 * nada que no deba estar en un archivo de registro. El criterio es sencillo:
 * si un dato sirve para USAR la cuenta de alguien o la del comercio, no se
 * escribe; si sirve para EXPLICAR qué pasó, sí.
 *
 * Nunca entra aquí: la llave secreta, el código de comercio, cabeceras, el
 * token entero, cookies, JWT, el número de tarjeta ni datos personales.
 *
 * Sí entra: un identificador de correlación, el pago, la orden de compra, el
 * ambiente, la operación, el resultado y cuánto tardó.
 */
export interface PaymentLogEntry {
  operation:
    | "create"
    | "redirect"
    | "return"
    | "commit"
    | "status"
    | "reconcile"
    | "refund"
    | "cancel"
    | "admin";
  result: string;
  correlationId?: string;
  paymentId?: string;
  buyOrder?: string;
  environment?: string;
  provider?: string;
  /** Se enmascara siempre: seis primeros y cuatro últimos. */
  token?: string;
  flow?: string;
  durationMs?: number;
  duplicate?: boolean;
  reason?: string;
  errorCategory?: string;
}

/** Identificador de correlación para enlazar las líneas de una misma petición. */
export function newCorrelationId(): string {
  return randomUUID().slice(0, 8);
}

export function paymentLog(entry: PaymentLogEntry): void {
  const line = {
    at: new Date().toISOString(),
    scope: "payments",
    ...entry,
    token: entry.token ? maskToken(entry.token) : undefined,
    reason: entry.reason ? scrub(entry.reason) : undefined,
    result: scrub(entry.result),
  };

  // Una sola línea JSON: legible por una persona y por un recolector de
  // registros sin tener que analizar texto libre.
  console.info(JSON.stringify(line));
}

/**
 * Categoría de un error, sin el mensaje.
 *
 * El mensaje de un error del SDK puede arrastrar lo que no debe; la categoría
 * es suficiente para alertar y para agrupar en un panel.
 */
export function errorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const message = error.message.toLowerCase();
  if (message.includes("timeout") || message.includes("econnaborted")) return "timeout";
  if (message.includes("network") || message.includes("enotfound")) return "network";
  if (message.includes("no está configurado")) return "not_configured";
  if (message.includes("desactivado")) return "production_blocked";
  if (message.includes("dominio esperado")) return "untrusted_redirect";
  return error.name === "PaymentProviderError" ? "provider" : "application";
}

/** Mide una operación y la registra con su duración, pase lo que pase. */
export async function timed<T>(
  entry: Omit<PaymentLogEntry, "result" | "durationMs">,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const value = await run();
    paymentLog({ ...entry, result: "ok", durationMs: Date.now() - started });
    return value;
  } catch (error) {
    paymentLog({
      ...entry,
      result: "error",
      errorCategory: errorCategory(error),
      durationMs: Date.now() - started,
    });
    throw error;
  }
}
