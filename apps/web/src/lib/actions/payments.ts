"use server";

import { env } from "@/lib/env";
import { PAYMENT_COLUMNS, startCheckout, type PaymentRow } from "@/lib/payments/checkout";
import { errorCategory, paymentLog } from "@/lib/payments/logging";
import { createAdminClient } from "@/lib/supabase/admin";
import { actionError, actionOk, type ActionResult } from "@/lib/utils/errors";

import { requireSession } from "./guards";

/**
 * Pago Protegido.
 *
 * El recorrido es el definitivo, con Webpay Plus detrás: la base calcula el
 * importe, se registra el intento, se crea la transacción en el proveedor y el
 * usuario pasa por una página de transición que envía el token por POST.
 *
 * Lo que NUNCA viene del navegador: el total, la comisión, el bono, el importe
 * de una extensión, la orden de compra, el token y la URL de retorno. Todo eso
 * se calcula o se construye en el servidor. Lo único que llega de fuera es el
 * identificador de la asignación, y sobre él se comprueba la propiedad.
 */

/** A dónde va el navegador después de pedir pagar. */
interface CheckoutRedirect {
  paymentId: string;
  /** Ruta interna de la página de transición, o del trabajo si ya está pagado. */
  redirectUrl: string;
}

export async function startProtectedPaymentAction(
  assignmentId: string,
): Promise<ActionResult<CheckoutRedirect>> {
  try {
    const { supabase } = await requireSession();

    const { data: paymentId, error } = await supabase.rpc("start_protected_payment", {
      p_assignment_id: assignmentId,
    });
    if (error) return actionError(error, "No pudimos iniciar el pago.");

    const admin = createAdminClient();
    const { data: payment } = await admin
      .from("payments")
      .select(PAYMENT_COLUMNS)
      .eq("id", String(paymentId))
      .maybeSingle<PaymentRow>();

    if (!payment) return { ok: false, error: "No encontramos el pago recién creado." };

    if (payment.status === "PAID") {
      return actionOk({ paymentId: payment.id, redirectUrl: `/mis-trabajos/${assignmentId}` });
    }
    if (payment.status === "UNDER_REVIEW") {
      return {
        ok: false,
        error:
          "Hay un pago de este trabajo en revisión. No inicies otro: te avisamos en cuanto se resuelva.",
      };
    }

    const { data: job } = await admin
      .from("jobs")
      .select("reference")
      .eq("id", payment.job_id)
      .maybeSingle<{ reference: string }>();

    const checkout = await startCheckout(admin, payment, job?.reference ?? payment.id);

    if (checkout.alreadySettled) {
      return actionOk({ paymentId: payment.id, redirectUrl: `/mis-trabajos/${assignmentId}` });
    }

    paymentLog({
      operation: "create",
      result: "ok",
      paymentId: payment.id,
      buyOrder: checkout.buyOrder,
      environment: checkout.environment,
      token: checkout.token,
    });

    // Se devuelve la ruta interna, no la de Webpay: el token tiene que viajar
    // por POST desde la página de transición, no por la barra de direcciones.
    return actionOk({
      paymentId: payment.id,
      redirectUrl: `/pagar/${assignmentId}/ir`,
    });
  } catch (error) {
    paymentLog({ operation: "create", result: "error", errorCategory: errorCategory(error) });
    return actionError(error, "No pudimos iniciar el pago.");
  }
}

/** ¿Está disponible el botón de simulación? Solo fuera de producción. */
export async function isPaymentSimulationEnabled(): Promise<boolean> {
  return (
    (env.PAYMENT_PROVIDER === "mock" || env.PAYMENT_PROVIDER === "mock-delayed") &&
    env.NODE_ENV !== "production"
  );
}

/** Nombre del proveedor activo, para que la pantalla no prometa lo que no hay. */
export async function activePaymentProviderLabel(): Promise<{
  live: boolean;
  environment: string;
}> {
  return {
    live: env.PAYMENT_PROVIDER === "transbank" && env.TRANSBANK_ENVIRONMENT === "production",
    environment:
      env.PAYMENT_PROVIDER === "transbank" ? env.TRANSBANK_ENVIRONMENT : env.PAYMENT_PROVIDER,
  };
}

/**
 * Cobro del tiempo adicional aceptado.
 *
 * Espejo exacto del pago protegido, con dos diferencias: el importe ya estaba
 * fijado por `answer_job_extension` desde la tarifa acordada, y este cobro no
 * habilita nada por sí mismo. Cuando se confirma, lo único que ocurre es que el
 * pago al trabajador sube.
 *
 * Es un pago **propio**: tiene su fila, su orden de compra, su token, su
 * idempotencia y sus eventos. No sustituye al principal ni lo modifica, y por
 * eso una extensión pagada no puede reactivar un trabajo cancelado ni duplicar
 * el pago al trabajador.
 */
export async function startExtensionPaymentAction(
  extensionId: string,
): Promise<ActionResult<CheckoutRedirect>> {
  try {
    const { supabase } = await requireSession();

    const { data: paymentId, error } = await supabase.rpc("start_extension_payment", {
      p_extension_id: extensionId,
    });
    if (error) return actionError(error, "No pudimos iniciar el cobro adicional.");

    const admin = createAdminClient();
    const { data: payment } = await admin
      .from("payments")
      .select(PAYMENT_COLUMNS)
      .eq("id", String(paymentId))
      .maybeSingle<PaymentRow>();

    if (!payment) return { ok: false, error: "No encontramos el cobro adicional." };

    if (payment.status === "PAID") {
      return actionOk({
        paymentId: payment.id,
        redirectUrl: `/mis-trabajos/${payment.assignment_id ?? ""}`,
      });
    }

    const { data: job } = await admin
      .from("jobs")
      .select("reference")
      .eq("id", payment.job_id)
      .maybeSingle<{ reference: string }>();

    const checkout = await startCheckout(
      admin,
      payment,
      `${job?.reference ?? payment.id}-EXT`,
    );

    if (checkout.alreadySettled) {
      return actionOk({
        paymentId: payment.id,
        redirectUrl: `/mis-trabajos/${payment.assignment_id ?? ""}`,
      });
    }

    paymentLog({
      operation: "create",
      result: "ok",
      paymentId: payment.id,
      buyOrder: checkout.buyOrder,
      environment: checkout.environment,
      token: checkout.token,
    });

    return actionOk({
      paymentId: payment.id,
      redirectUrl: `/pagar/${payment.assignment_id ?? ""}/ir`,
    });
  } catch (error) {
    paymentLog({ operation: "create", result: "error", errorCategory: errorCategory(error) });
    return actionError(error, "No pudimos iniciar el cobro adicional.");
  }
}
