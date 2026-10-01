import { NextResponse, type NextRequest } from "next/server";

import { env, resolveDataSource } from "@/lib/env";
import { isAuthorizedCronRequest } from "@/lib/payments/cron-auth";
import { errorCategory, paymentLog } from "@/lib/payments/logging";
import { reconcilePayments } from "@/lib/payments/reconcile";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Conciliación programada.
 *
 * Webpay Plus no tiene webhooks: si el navegador de quien paga no vuelve, la
 * plataforma solo se entera preguntando (`docs/TRANSBANK.md` §7). Esta ruta
 * ejecuta exactamente el mismo servicio que el botón «Conciliar» de
 * `/admin/pagos`, con el mismo margen de 5 minutos para no pisar un retorno en
 * curso. Es idempotente: llamarla de más no cambia nada.
 *
 * Protegida por `CRON_SECRET` (`Authorization: Bearer …`). Sin secreto
 * configurado responde 503. Recomendado: cada 10 minutos.
 */
export const dynamic = "force-dynamic";

async function run(request: NextRequest) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET no configurado" }, { status: 503 });
  }
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), env.CRON_SECRET)) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }
  if (resolveDataSource() !== "supabase") {
    return NextResponse.json({ error: "sin base de datos" }, { status: 503 });
  }

  try {
    const summary = await reconcilePayments(createAdminClient(), { olderThanMinutes: 5 });
    paymentLog({
      operation: "admin",
      result: `cron:reconcile:${summary.changed}/${summary.examined} expirados:${summary.expired}`,
    });
    return NextResponse.json({
      ok: true,
      examined: summary.examined,
      changed: summary.changed,
      expired: summary.expired,
    });
  } catch (error) {
    // El detalle no sale en la respuesta: puede venir del proveedor.
    paymentLog({ operation: "admin", result: "cron:reconcile:error", errorCategory: errorCategory(error) });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
