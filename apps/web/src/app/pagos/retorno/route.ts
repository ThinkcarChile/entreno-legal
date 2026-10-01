import { NextResponse, type NextRequest } from "next/server";

import { classifyReturn } from "@/lib/payments";
import { handleReturn } from "@/lib/payments/return-handler";
import { returnTargetFor } from "@/lib/payments/return-target";
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
  const admin = createAdminClient();

  // El pago se resuelve SIEMPRE con el token, haya sesión o no: la cookie
  // SameSite=Lax no viaja en el POST de Transbank, una PWA instalada vuelve en
  // otro contenedor de cookies, y una sesión pudo vencer durante el pago. La
  // sesión solo decide a dónde va el navegador. Ver handleReturn.
  let outcome: Awaited<ReturnType<typeof handleReturn>>;
  try {
    outcome = await handleReturn(admin, flow, null);
  } catch (error) {
    paymentLog({
      operation: "return",
      result: "error",
      flow: flow.kind,
      errorCategory: errorCategory(error),
    });
    return NextResponse.redirect(
      viewer
        ? `${origin}/mis-trabajos/publicados?pago=verificando`
        : `${origin}/entrar?next=${encodeURIComponent("/mis-trabajos/publicados?pago=verificando")}`,
    );
  }

  const owner =
    "payment" in outcome && outcome.payment ? outcome.payment.client_id : null;

  // Sin sesión: a entrar, y de vuelta al resultado de su pago.
  if (!viewer) {
    const target = owner ? returnTargetFor(outcome) : "/mis-trabajos/publicados";
    return NextResponse.redirect(`${origin}/entrar?next=${encodeURIComponent(target)}`);
  }

  // La sesión de otra persona: el pago quedó resuelto para su dueño, pero a un
  // tercero no se le cuenta nada de él.
  if (owner && owner !== viewer.id) {
    paymentLog({ operation: "return", result: "foreign_session", flow: flow.kind });
    return NextResponse.redirect(`${origin}/mis-trabajos/publicados?pago=desconocido`);
  }

  return NextResponse.redirect(`${origin}${returnTargetFor(outcome)}`);
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
