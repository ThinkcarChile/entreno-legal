import { NextResponse, type NextRequest } from "next/server";

import { getPaymentProvider } from "@/lib/payments";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/verified-user";
import { resolveDataSource } from "@/lib/env";

/**
 * Retorno del proveedor de pago.
 *
 * Es la misma ruta para el proveedor simulado y para Webpay Plus: ambos vuelven
 * con un token, se confirma contra el proveedor y se registra el resultado.
 * Cuando llegue Transbank, aquí no cambia nada.
 *
 * La confirmación se hace SIEMPRE contra el proveedor. No se confía en los
 * parámetros de la URL para dar un pago por aprobado.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const token = searchParams.get("token_ws") ?? searchParams.get("token");

  if (!token || resolveDataSource() !== "supabase") {
    return NextResponse.redirect(`${origin}/mis-trabajos/publicados?pago=error`);
  }

  const supabase = await createClient();
  const viewer = await getVerifiedUser(supabase);
  if (!viewer) return NextResponse.redirect(`${origin}/entrar`);

  const admin = createAdminClient();
  const { data: payment } = await admin
    .from("payments")
    .select("id,client_id,assignment_id,status,amount")
    .eq("provider_token", token)
    .maybeSingle<{
      id: string;
      client_id: string;
      assignment_id: string | null;
      status: string;
      amount: number;
    }>();

  if (!payment) {
    return NextResponse.redirect(`${origin}/mis-trabajos/publicados?pago=desconocido`);
  }

  // El pago pertenece a quien lo inició y a nadie más.
  if (payment.client_id !== viewer.id) {
    return NextResponse.redirect(`${origin}/mis-trabajos/publicados?pago=error`);
  }

  if (payment.status === "PAID") {
    return NextResponse.redirect(`${origin}/mis-trabajos/${payment.assignment_id}?pago=ok`);
  }

  const provider = getPaymentProvider();
  const result = await provider.confirmPayment({ token });

  await admin
    .from("payments")
    .update({
      status: result.status,
      authorization_code: result.authorizationCode,
      card_last_digits: result.cardLastDigits,
      payment_type_code: result.paymentTypeCode,
      installments: result.installments,
      authorized_at: result.status === "PAID" ? new Date().toISOString() : null,
      paid_at: result.status === "PAID" ? new Date().toISOString() : null,
      failed_at: result.status === "FAILED" ? new Date().toISOString() : null,
    })
    .eq("id", payment.id);

  // La carga útil ya saneada queda en la bitácora del pago.
  await admin.from("payment_events").insert({
    payment_id: payment.id,
    to_status: result.status,
    provider: provider.id,
    payload: result.raw,
  });

  const target =
    result.status === "PAID"
      ? `/mis-trabajos/${payment.assignment_id}?pago=ok`
      : `/pagar/${payment.assignment_id}?pago=rechazado`;

  return NextResponse.redirect(`${origin}${target}`);
}
