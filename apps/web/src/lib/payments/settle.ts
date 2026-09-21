import type { SupabaseClient } from "@supabase/supabase-js";

import type { ConfirmPaymentResult } from "./provider";

/**
 * Resultado de asentar en la base lo que dijo el proveedor. Es lo que devuelve
 * `confirm_payment_result`, tal cual: la base decidió, aquí solo se lee.
 */
export interface SettlementOutcome {
  /** `applied` si este evento se registró ahora; `duplicate` si ya estaba. */
  outcome: "applied" | "duplicate";
  paymentStatus: string;
  reviewReason: string | null;
  jobStatus: string | null;
  assignmentStatus: string | null;
  payoutId: string | null;
}

/**
 * Registra en la base la respuesta del proveedor, una sola vez y de forma
 * atómica.
 *
 * Es la ÚNICA vía por la que un resultado del proveedor llega a `payments`. La
 * usa la ruta `/pagos/retorno` hoy, la usará el webhook de Webpay mañana, y la
 * usan las pruebas de concurrencia con el proveedor retardado, para que lo que
 * se prueba sea exactamente lo que corre.
 *
 * Toda la decisión —habilitar el trabajo, o dejar el dinero en revisión para
 * devolverlo porque el trabajo ya no lo espera— vive en `confirm_payment_result`
 * y en los disparadores de `payments`, bajo los bloqueos de trabajo, asignación
 * y pago. Aquí no se decide nada.
 *
 * `admin` tiene que ser el cliente con la clave de servicio: la función no es
 * ejecutable por ningún usuario.
 */
export async function applyProviderResult(
  admin: SupabaseClient,
  paymentId: string,
  providerId: string,
  result: ConfirmPaymentResult,
): Promise<SettlementOutcome> {
  const claimed = result.status === "PAID" ? "PAID" : "FAILED";

  // Un proveedor real no aprueba un pago «de 0». El proveedor simulado sí
  // devuelve 0 cuando recupera un token tras reiniciar el servidor de
  // desarrollo: en ese caso el importe es desconocido, no cero, y no debe
  // provocar una revisión por discrepancia.
  const amount = result.amount.amount > 0 ? result.amount.amount : null;

  const { data, error } = await admin.rpc("confirm_payment_result", {
    p_payment_id: paymentId,
    p_provider: providerId,
    p_provider_event_id: result.providerEventId,
    p_result: claimed,
    p_amount: amount,
    p_details: {
      authorization_code: result.authorizationCode,
      card_last_digits: result.cardLastDigits,
      payment_type_code: result.paymentTypeCode,
      installments: result.installments,
      transaction_date: result.transactionDate,
      raw: result.raw,
    },
  });

  if (error) throw new Error(`No se pudo asentar el resultado del pago: ${error.message}`);

  const row = data as Record<string, unknown>;
  return {
    outcome: row.outcome === "duplicate" ? "duplicate" : "applied",
    paymentStatus: String(row.payment_status),
    reviewReason: (row.review_reason as string | null) ?? null,
    jobStatus: (row.job_status as string | null) ?? null,
    assignmentStatus: (row.assignment_status as string | null) ?? null,
    payoutId: (row.payout_id as string | null) ?? null,
  };
}
