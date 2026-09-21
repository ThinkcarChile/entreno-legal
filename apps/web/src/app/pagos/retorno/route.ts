import { NextResponse, type NextRequest } from "next/server";

import { applyProviderResult, getPaymentProvider } from "@/lib/payments";
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
    .select("id,client_id,assignment_id,job_id,status,amount")
    .eq("provider_token", token)
    .maybeSingle<{
      id: string;
      client_id: string;
      assignment_id: string | null;
      job_id: string;
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

  // Un pago que ya se resolvió no se vuelve a confirmar con el proveedor: el
  // usuario recargó la página de retorno, o volvió atrás.
  if (payment.status === "PAID") {
    return NextResponse.redirect(`${origin}/mis-trabajos/${payment.assignment_id}?pago=ok`);
  }
  if (payment.status === "UNDER_REVIEW") {
    return NextResponse.redirect(`${origin}/mis-trabajos/publicados/${payment.job_id}?pago=revision`);
  }

  const provider = getPaymentProvider();
  const result = await provider.confirmPayment({ token });

  // Todo lo que decide sobre el dinero pasa por aquí, y por ningún otro sitio:
  // una transacción, tres bloqueos, un solo registro por evento del proveedor.
  // Que el trabajo se habilite o que el pago quede en revisión para devolución
  // porque el cliente canceló mientras tanto lo decide la base, no esta ruta.
  const settlement = await applyProviderResult(admin, payment.id, provider.id, result);

  const target =
    settlement.paymentStatus === "PAID"
      ? `/mis-trabajos/${payment.assignment_id}?pago=ok`
      : settlement.paymentStatus === "UNDER_REVIEW"
        ? `/mis-trabajos/publicados/${payment.job_id}?pago=revision`
        : settlement.jobStatus === "CANCELLED"
          ? `/mis-trabajos/publicados/${payment.job_id}?pago=cancelado`
          : `/pagar/${payment.assignment_id}?pago=rechazado`;

  return NextResponse.redirect(`${origin}${target}`);
}
