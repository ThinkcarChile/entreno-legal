import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";

import { getPaymentProvider } from "./index";
import { buildBuyOrder, buildSessionId } from "./transbank/identifiers";
import { isReconcilable, PaymentProviderError, type ProviderSnapshot } from "./provider";

/**
 * Salida hacia el proveedor: de un pago interno a un formulario de Webpay.
 *
 * El orden importa y es el único correcto:
 *
 *   1. La base ya calculó el importe (`start_protected_payment`). Aquí no se
 *      recalcula nada ni se acepta nada del navegador.
 *   2. Se construyen `buy_order` y `session_id`.
 *   3. **Se persisten ANTES de llamar a Transbank** (`register_payment_attempt`).
 *      Es lo que salva el caso peor: Transbank crea la transacción, la respuesta
 *      se pierde por la red y nadie sabría que existe. Con el intento ya
 *      escrito, la conciliación la encuentra por `buy_order`.
 *   4. Se crea la transacción en el proveedor.
 *   5. Se guardan token y URL **en su intento** (`record_payment_attempt_token`),
 *      y en el pago solo si ese intento sigue siendo el vigente. El token de un
 *      intento anterior no se sobrescribe nunca: queda en `payment_attempts`.
 *   6. Se devuelve la URL para el formulario POST.
 */
export interface CheckoutStart {
  paymentId: string;
  /** URL del formulario de Webpay. Ya validada contra el dominio del ambiente. */
  redirectUrl: string;
  token: string;
  buyOrder: string;
  environment: string;
  /** `true` si el pago ya estaba resuelto y no hay que ir a ningún sitio. */
  alreadySettled: boolean;
}

export interface PaymentRow {
  id: string;
  job_id: string;
  assignment_id: string | null;
  client_id: string;
  /** `JOB` o `EXTENSION`: decide a qué pantalla vuelve el cliente. */
  purpose: string;
  amount: number;
  currency: string;
  status: string;
  provider_token: string | null;
  buy_order: string | null;
  session_id: string | null;
  environment: string | null;
  /** Cuántos intentos se registraron. El vigente es el de `buy_order`. */
  attempt: number;
}

export const PAYMENT_COLUMNS =
  "id,job_id,assignment_id,client_id,purpose,amount,currency,status,provider_token," +
  "buy_order,session_id,environment,attempt";

/** Código de PostgreSQL de una regla de negocio que la base dice en voz alta. */
const CHECK_VIOLATION = "23514";

/** La URL de retorno. Se deriva del sitio, nunca del navegador. */
export function returnUrl(): string {
  return `${env.NEXT_PUBLIC_SITE_URL}/pagos/retorno`;
}

/**
 * Prepara el pago en el proveedor y deja todo persistido.
 *
 * `admin` es el cliente con la clave de servicio: registrar el intento y
 * guardar el token son escrituras del sistema, no del usuario.
 */
export async function startCheckout(
  admin: SupabaseClient,
  payment: PaymentRow,
  reference: string,
): Promise<CheckoutStart> {
  const provider = getPaymentProvider();
  const environment = isReconcilable(provider) ? provider.environment : "mock";

  if (payment.status === "PAID" || payment.status === "UNDER_REVIEW") {
    return {
      paymentId: payment.id,
      redirectUrl: "",
      token: "",
      buyOrder: payment.buy_order ?? "",
      environment,
      alreadySettled: true,
    };
  }

  // Cada intento estrena orden de compra: Webpay rechaza reutilizar la de una
  // transacción viva, y reintentar después de un abandono tiene que funcionar.
  const buyOrder = buildBuyOrder(payment.id);
  const sessionId = payment.session_id ?? buildSessionId(payment.id);
  const target = returnUrl();

  const { error: attemptError } = await admin.rpc("register_payment_attempt", {
    p_payment_id: payment.id,
    p_provider: provider.id,
    p_environment: environment,
    p_buy_order: buyOrder,
    p_session_id: sessionId,
    p_return_url: target,
  });
  if (attemptError) {
    // Una regla de la base —el intento anterior se está confirmando, el tope
    // de intentos seguidos, un pago que ya no admite otro— viene escrita para
    // quien paga y se muestra tal cual. Se dice ANTES de llamar a Transbank:
    // ningún rechazo abre una transacción.
    if (attemptError.code === CHECK_VIOLATION) {
      throw Object.assign(new Error(attemptError.message), { code: CHECK_VIOLATION });
    }
    throw new Error(`No se pudo registrar el intento de pago: ${attemptError.message}`);
  }

  let created;
  try {
    created = await provider.createPayment({
      paymentId: payment.id,
      jobId: payment.job_id,
      reference,
      amount: { amount: payment.amount, currency: "CLP" },
      returnUrl: target,
      sessionId,
      buyOrder,
    });
  } catch (error) {
    // La transacción pudo quedar creada en el proveedor aunque la respuesta se
    // perdiera. El intento ya está escrito; aquí solo se anota el motivo, en el
    // pago y en su intento.
    await admin
      .from("payments")
      .update({
        failure_reason: "provider_error",
        updated_at: new Date().toISOString(),
      })
      .eq("id", payment.id);
    await admin
      .from("payment_attempts")
      .update({ failure_reason: "provider_error" })
      .eq("buy_order", buyOrder);
    throw error instanceof PaymentProviderError
      ? error
      : new PaymentProviderError(provider.id, "No se pudo crear la transacción.");
  }

  // El token va a SU intento, identificado por la orden de compra. Si mientras
  // se creaba la transacción se abrió otro intento —doble clic, dos pestañas—,
  // este token queda en el historial y no pisa el del vigente.
  const { data: isCurrent, error: tokenError } = await admin.rpc("record_payment_attempt_token", {
    p_payment_id: payment.id,
    p_buy_order: buyOrder,
    p_token: created.token,
    p_redirect_url: created.redirectUrl,
    p_provider_transaction_id: created.providerTransactionId,
  });
  if (tokenError) {
    throw new Error(`No se pudo guardar el token del pago: ${tokenError.message}`);
  }
  if (isCurrent !== true) {
    throw new Error(
      "Se abrió otro intento de pago mientras se preparaba este. Vuelve a la pantalla de pago.",
    );
  }

  return {
    paymentId: payment.id,
    redirectUrl: created.redirectUrl,
    token: created.token,
    buyOrder,
    environment,
    alreadySettled: false,
  };
}

/**
 * Guarda la foto del proveedor sin decidir nada sobre el dinero.
 *
 * Se llama después de un `commit` o de un `status`. Lo que habilita o no un
 * trabajo lo sigue decidiendo `confirm_payment_result`, bajo sus bloqueos.
 */
export async function recordSnapshot(
  admin: SupabaseClient,
  paymentId: string,
  providerId: string,
  snapshot: ProviderSnapshot,
): Promise<void> {
  await admin.rpc("record_provider_snapshot", {
    p_payment_id: paymentId,
    p_provider: providerId,
    p_snapshot: {
      provider_status: snapshot.providerStatus,
      response_code: snapshot.responseCode,
      vci: snapshot.vci,
      accounting_date: snapshot.accountingDate,
      transaction_date: snapshot.transactionDate,
      installments_number: snapshot.installmentsNumber,
      installments_amount: snapshot.installmentsAmount,
      card_last_digits: snapshot.cardLastDigits,
      payment_type_code: snapshot.paymentTypeCode,
      authorization_code: snapshot.authorizationCode,
    },
  });
}
