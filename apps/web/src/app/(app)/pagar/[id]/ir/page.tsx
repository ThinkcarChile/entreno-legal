import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { WebpayRedirect } from "@/components/payments/webpay-redirect";
import { requireOnboardedUser } from "@/lib/auth/session";
import { isTrustedRedirect, type TransbankEnvironment } from "@/lib/payments";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatMoney } from "@/lib/utils/money";

export const metadata: Metadata = {
  title: "Redirigiendo a Webpay",
  robots: { index: false, follow: false },
};

/**
 * Página de transición hacia el formulario de pago.
 *
 * Existe porque Webpay exige un POST con el token, y porque salir del sitio sin
 * aviso hacia una pantalla que pide una tarjeta es la forma más rápida de que
 * alguien crea que le están estafando.
 *
 * Se vuelve a validar aquí que la URL guardada sigue siendo de Transbank y del
 * ambiente correcto. Ya se validó al crearla; se repite porque este es el punto
 * exacto en que un valor de la base se convierte en el destino del navegador de
 * una persona, y ahí no se confía en que la validación anterior ocurrió.
 */
export const dynamic = "force-dynamic";

export default async function WebpayTransitionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireOnboardedUser(`/pagar/${id}/ir`);

  const admin = createAdminClient();
  const { data: payment } = await admin
    .from("payments")
    .select(
      "id,client_id,assignment_id,job_id,amount,status,provider_token,redirect_url,environment",
    )
    .eq("assignment_id", id)
    .in("status", ["CREATED", "PENDING"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{
      id: string;
      client_id: string;
      assignment_id: string | null;
      job_id: string;
      amount: number;
      status: string;
      provider_token: string | null;
      redirect_url: string | null;
      environment: string | null;
    }>();

  if (!payment) notFound();
  // El pago es de quien lo inició. Cambiar el identificador no sirve de nada.
  if (payment.client_id !== session.id) redirect("/mis-trabajos/publicados");

  if (!payment.provider_token || !payment.redirect_url) {
    // Sin transacción creada no hay a dónde ir: se vuelve a la pantalla de pago.
    redirect(`/pagar/${id}?pago=incompleto`);
  }

  const environment = (payment.environment ?? "integration") as TransbankEnvironment;
  if (environment !== "mock" && !isTrustedRedirect(payment.redirect_url, environment)) {
    redirect(`/pagar/${id}?pago=error`);
  }

  const { data: job } = await admin
    .from("jobs")
    .select("title")
    .eq("id", payment.job_id)
    .maybeSingle<{ title: string }>();

  return (
    <WebpayRedirect
      action={payment.redirect_url}
      token={payment.provider_token}
      amountLabel={formatMoney({ amount: payment.amount, currency: "CLP" })}
      jobTitle={job?.title ?? "Trabajo"}
    />
  );
}
