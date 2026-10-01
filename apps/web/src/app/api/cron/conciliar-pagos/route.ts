import { NextResponse, type NextRequest } from "next/server";

import { env, resolveDataSource } from "@/lib/env";
import { isAuthorizedCronRequest } from "@/lib/payments/cron-auth";
import { errorCategory, paymentLog } from "@/lib/payments/logging";
import { reconcilePayments } from "@/lib/payments/reconcile";
import { reconcileAttemptRefunds, reconcileRefunds } from "@/lib/payments/refund-reconcile";
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
 * Después, las devoluciones que quedaron sin resultado en firme
 * (`refund-reconcile.ts`): las que siguen «en curso» pasado el margen pasan a
 * «por confirmar», y las por confirmar se contrastan con `status(token)`. Va
 * aparte de los pagos a propósito: que una de las dos falle no impide la otra.
 * Y por último las devoluciones de cobros duplicados, igual pero contra el
 * token de su intento.
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

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (error) {
    paymentLog({ operation: "admin", result: "cron:reconcile:error", errorCategory: errorCategory(error) });
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  let payments: { examined: number; changed: number; expired: number } | null = null;
  let refunds: { examined: number; resolved: number; undecided: number } | null = null;
  let attemptRefunds: { examined: number; resolved: number; undecided: number } | null = null;

  try {
    const summary = await reconcilePayments(admin, { olderThanMinutes: 5 });
    payments = { examined: summary.examined, changed: summary.changed, expired: summary.expired };
    paymentLog({
      operation: "admin",
      result: `cron:reconcile:${summary.changed}/${summary.examined} expirados:${summary.expired}`,
    });
  } catch (error) {
    // El detalle no sale en la respuesta: puede venir del proveedor.
    paymentLog({ operation: "admin", result: "cron:reconcile:error", errorCategory: errorCategory(error) });
  }

  try {
    const summary = await reconcileRefunds(admin, { minAgeMinutes: 10 });
    refunds = { examined: summary.examined, resolved: summary.resolved, undecided: summary.undecided };
    paymentLog({
      operation: "admin",
      result: `cron:refunds:${summary.resolved}/${summary.examined} por_confirmar:${summary.undecided}`,
    });
  } catch (error) {
    paymentLog({ operation: "admin", result: "cron:refunds:error", errorCategory: errorCategory(error) });
  }

  try {
    const summary = await reconcileAttemptRefunds(admin, { minAgeMinutes: 10 });
    attemptRefunds = { examined: summary.examined, resolved: summary.resolved, undecided: summary.undecided };
    paymentLog({
      operation: "admin",
      result: `cron:attempt_refunds:${summary.resolved}/${summary.examined} por_confirmar:${summary.undecided}`,
    });
  } catch (error) {
    paymentLog({ operation: "admin", result: "cron:attempt_refunds:error", errorCategory: errorCategory(error) });
  }

  if (!payments || !refunds || !attemptRefunds) {
    return NextResponse.json({ ok: false, payments, refunds, attemptRefunds }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...payments, refunds, attemptRefunds });
}

export const GET = run;
export const POST = run;
