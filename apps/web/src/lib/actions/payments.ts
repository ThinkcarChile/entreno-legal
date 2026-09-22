"use server";

import { env } from "@/lib/env";
import { getPaymentProvider } from "@/lib/payments";
import { createAdminClient } from "@/lib/supabase/admin";
import { actionError, actionOk, type ActionResult } from "@/lib/utils/errors";

import { requireSession } from "./guards";

/**
 * Pago Protegido.
 *
 * El recorrido es el definitivo: crear el pago en la base, pedirle al proveedor
 * una transacción, redirigir al usuario y confirmar al volver. Hoy el proveedor
 * es `MockPaymentProvider`; cuando se integre Webpay Plus se cambia solo esa
 * pieza y ni esta acción ni la ruta de retorno se tocan.
 *
 * Los montos NUNCA vienen del navegador: los calcula `start_protected_payment`
 * en la base, a partir de la asignación.
 */

export async function startProtectedPaymentAction(
  assignmentId: string,
): Promise<ActionResult<{ paymentId: string; redirectUrl: string }>> {
  try {
    const { supabase, userId } = await requireSession();

    const { data: paymentId, error } = await supabase.rpc("start_protected_payment", {
      p_assignment_id: assignmentId,
    });

    if (error) return actionError(error, "No pudimos iniciar el pago.");

    const { data: payment } = await supabase
      .from("payments")
      .select("id,amount,currency,job_id,status,provider_token")
      .eq("id", String(paymentId))
      .maybeSingle<{
        id: string;
        amount: number;
        currency: string;
        job_id: string;
        status: string;
        provider_token: string | null;
      }>();

    if (!payment) return { ok: false, error: "No encontramos el pago recién creado." };

    // Si ya está pagado, no se vuelve a cobrar.
    if (payment.status === "PAID") {
      return actionOk({
        paymentId: payment.id,
        redirectUrl: `/mis-trabajos/${assignmentId}`,
      });
    }

    const { data: job } = await supabase
      .from("jobs")
      .select("reference")
      .eq("id", payment.job_id)
      .maybeSingle<{ reference: string }>();

    const provider = getPaymentProvider();
    const created = await provider.createPayment({
      paymentId: payment.id,
      jobId: payment.job_id,
      reference: job?.reference ?? payment.id,
      amount: { amount: payment.amount, currency: "CLP" },
      returnUrl: `${env.NEXT_PUBLIC_SITE_URL}/pagos/retorno`,
      // Identificador de sesión derivado del usuario. Nunca su correo.
      sessionId: userId.slice(0, 26),
    });

    // La escritura del identificador del proveedor es del sistema, no del
    // usuario: va con la clave de servicio.
    const admin = createAdminClient();
    await admin
      .from("payments")
      .update({
        status: created.status,
        provider: provider.id,
        provider_transaction_id: created.providerTransactionId,
        provider_token: created.token,
      })
      .eq("id", payment.id);

    return actionOk({ paymentId: payment.id, redirectUrl: created.redirectUrl });
  } catch (error) {
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

/**
 * Cobro del tiempo adicional aceptado.
 *
 * Espejo exacto del pago protegido, con dos diferencias: el importe ya estaba
 * fijado por `answer_job_extension` desde la tarifa acordada, y este cobro no
 * habilita nada por sí mismo. Cuando se confirma, lo único que ocurre es que el
 * pago al trabajador sube.
 */
export async function startExtensionPaymentAction(
  extensionId: string,
): Promise<ActionResult<{ paymentId: string; redirectUrl: string }>> {
  try {
    const { supabase, userId } = await requireSession();

    const { data: paymentId, error } = await supabase.rpc("start_extension_payment", {
      p_extension_id: extensionId,
    });
    if (error) return actionError(error, "No pudimos iniciar el cobro adicional.");

    const { data: payment } = await supabase
      .from("payments")
      .select("id,amount,job_id,assignment_id,status")
      .eq("id", String(paymentId))
      .maybeSingle<{
        id: string;
        amount: number;
        job_id: string;
        assignment_id: string | null;
        status: string;
      }>();

    if (!payment) return { ok: false, error: "No encontramos el cobro adicional." };

    if (payment.status === "PAID") {
      return actionOk({
        paymentId: payment.id,
        redirectUrl: `/mis-trabajos/${payment.assignment_id ?? ""}`,
      });
    }

    const { data: job } = await supabase
      .from("jobs")
      .select("reference")
      .eq("id", payment.job_id)
      .maybeSingle<{ reference: string }>();

    const provider = getPaymentProvider();
    const created = await provider.createPayment({
      paymentId: payment.id,
      jobId: payment.job_id,
      reference: `${job?.reference ?? payment.id}-EXT`,
      amount: { amount: payment.amount, currency: "CLP" },
      returnUrl: `${env.NEXT_PUBLIC_SITE_URL}/pagos/retorno`,
      sessionId: userId.slice(0, 26),
    });

    const admin = createAdminClient();
    await admin
      .from("payments")
      .update({
        status: created.status,
        provider: provider.id,
        provider_transaction_id: created.providerTransactionId,
        provider_token: created.token,
      })
      .eq("id", payment.id);

    return actionOk({ paymentId: payment.id, redirectUrl: created.redirectUrl });
  } catch (error) {
    return actionError(error, "No pudimos iniciar el cobro adicional.");
  }
}
