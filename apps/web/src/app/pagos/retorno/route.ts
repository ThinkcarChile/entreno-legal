import { NextResponse, type NextRequest } from "next/server";

import { classifyReturn } from "@/lib/payments";
import { handleReturn } from "@/lib/payments/return-handler";
import { errorCategory, paymentLog } from "@/lib/payments/logging";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/verified-user";
import { resolveDataSource } from "@/lib/env";

/**
 * Retorno del proveedor de pago.
 *
 * Webpay vuelve aquí por **GET o por POST** según el flujo y el ambiente: la
 * documentación dice que desde la versión 1.1 del API el retorno normal es GET,
 * pero que el pago abortado en integración sigue llegando por POST. Soportar
 * solo uno de los dos deja un flujo entero sin recoger.
 *
 * Esta ruta no decide nada sobre el dinero. Lee los parámetros, los clasifica
 * en uno de los cuatro flujos oficiales y delega en `handleReturn`, que es
 * quien habla con el proveedor y con la base. Aquí solo se elige a dónde va el
 * navegador.
 *
 * Un pago NUNCA se da por aprobado por lo que traiga la URL: se confirma contra
 * el proveedor, y la decisión final la toma `confirm_payment_result` bajo los
 * bloqueos de trabajo, asignación y pago.
 */
async function handle(request: NextRequest, values: Record<string, string | null>) {
  const { origin } = new URL(request.url);
  const flow = classifyReturn(values);

  if (resolveDataSource() !== "supabase") {
    return NextResponse.redirect(`${origin}/mis-trabajos/publicados?pago=error`);
  }

  const supabase = await createClient();
  const viewer = await getVerifiedUser(supabase);
  if (!viewer) {
    // Sin sesión no se resuelve nada: se vuelve a entrar y el pago queda donde
    // estaba, listo para que la conciliación lo cierre si hizo falta.
    return NextResponse.redirect(`${origin}/entrar?next=%2Fmis-trabajos%2Fpublicados`);
  }

  const admin = createAdminClient();

  try {
    const outcome = await handleReturn(admin, flow, viewer.id);

    switch (outcome.kind) {
      case "SETTLED":
        return NextResponse.redirect(
          outcome.settlement.paymentStatus === "PAID"
            ? `${origin}/mis-trabajos/${outcome.payment.assignment_id}?pago=ok`
            : outcome.settlement.jobStatus === "CANCELLED"
              ? `${origin}/mis-trabajos/publicados/${outcome.payment.job_id}?pago=cancelado`
              : `${origin}/pagar/${outcome.payment.assignment_id}?pago=rechazado`,
        );

      case "REVIEW":
        return NextResponse.redirect(
          `${origin}/mis-trabajos/publicados/${outcome.payment.job_id}?pago=revision`,
        );

      case "ABANDONED":
        return NextResponse.redirect(
          `${origin}/pagar/${outcome.payment.assignment_id}?pago=${
            outcome.reason === "form_timeout"
              ? "tiempo"
              : outcome.reason === "aborted_by_user"
                ? "cancelado"
                : "incompleto"
          }`,
        );

      case "PENDING":
        return NextResponse.redirect(
          `${origin}/mis-trabajos/publicados/${outcome.payment.job_id}?pago=verificando`,
        );

      case "ALREADY":
        return NextResponse.redirect(
          outcome.payment.assignment_id
            ? `${origin}/mis-trabajos/${outcome.payment.assignment_id}?pago=ok`
            : `${origin}/mis-trabajos/publicados?pago=ok`,
        );

      case "FORBIDDEN":
        return NextResponse.redirect(`${origin}/mis-trabajos/publicados?pago=error`);

      default:
        return NextResponse.redirect(`${origin}/mis-trabajos/publicados?pago=desconocido`);
    }
  } catch (error) {
    // Un fallo aquí no puede dejar al cliente sin saber qué pasó, y tampoco
    // puede cobrar dos veces: el pago queda como esté y lo cierra la
    // conciliación. El mensaje del error NO se propaga a la URL.
    paymentLog({
      operation: "return",
      result: "error",
      flow: flow.kind,
      errorCategory: errorCategory(error),
    });
    return NextResponse.redirect(`${origin}/mis-trabajos/publicados?pago=verificando`);
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  return handle(request, {
    token_ws: searchParams.get("token_ws"),
    TBK_TOKEN: searchParams.get("TBK_TOKEN"),
    TBK_ID_SESION: searchParams.get("TBK_ID_SESION"),
    TBK_ID_SESSION: searchParams.get("TBK_ID_SESSION"),
    TBK_ORDEN_COMPRA: searchParams.get("TBK_ORDEN_COMPRA"),
  });
}

/**
 * El mismo tratamiento por POST.
 *
 * Los parámetros pueden venir como formulario o, en algún despliegue, en la
 * propia cadena de consulta; se leen los dos sitios y manda el cuerpo.
 */
export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  let form: FormData | null = null;
  try {
    form = await request.formData();
  } catch {
    form = null;
  }

  const read = (name: string): string | null => {
    const fromForm = form?.get(name);
    if (typeof fromForm === "string" && fromForm.trim().length > 0) return fromForm;
    return searchParams.get(name);
  };

  return handle(request, {
    token_ws: read("token_ws"),
    TBK_TOKEN: read("TBK_TOKEN"),
    TBK_ID_SESION: read("TBK_ID_SESION"),
    TBK_ID_SESSION: read("TBK_ID_SESSION"),
    TBK_ORDEN_COMPRA: read("TBK_ORDEN_COMPRA"),
  });
}
