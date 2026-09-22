import type { SupabaseClient } from "@supabase/supabase-js";

import { getPaymentProvider } from "./index";
import { errorCategory, paymentLog } from "./logging";
import { recordSnapshot } from "./checkout";
import { applyProviderResult } from "./settle";
import { findMismatches } from "./transbank/mapping";
import { isReconcilable, type ProviderSnapshot } from "./provider";

/**
 * Conciliación.
 *
 * Existe porque **Webpay Plus no tiene webhooks**. No se inventa uno: la única
 * fuente de verdad sobre una transacción es el retorno, el `commit` y la
 * consulta de estado. Si el navegador de quien paga muere entre el formulario
 * y el retorno —se le acaba la batería, cambia de red, cierra la pestaña—
 * nadie le va a contar a la plataforma lo que pasó. Hay que preguntarlo.
 *
 * Esta función pregunta. Toma los pagos sin estado final, consulta su estado
 * real en el proveedor y los asienta por la MISMA vía que el retorno:
 * `confirm_payment_result`, con sus bloqueos y sus invariantes. No hay un
 * camino corto que salte las comprobaciones porque el dinero se haya
 * encontrado por aquí.
 *
 * Es idempotente de punta a punta: la clave del evento es la misma que usaría
 * el `commit` del mismo token, así que conciliar un pago ya asentado por el
 * retorno no crea un segundo evento, ni un segundo pago al trabajador, ni una
 * segunda notificación.
 *
 * Webpay responde por una transacción durante **7 días**. Pasado ese plazo, un
 * pago sin resolver ya no se puede conciliar automáticamente y necesita a una
 * persona; la consulta que alimenta esto lo tiene en cuenta.
 */

export interface ReconcileOptions {
  /** Cuántos minutos hay que esperar antes de tocar un pago recién creado. */
  olderThanMinutes?: number;
  limit?: number;
  /** Concilia un solo pago, por su identificador. Para la acción de soporte. */
  paymentId?: string;
}

export interface ReconcileResult {
  paymentId: string;
  before: string;
  after: string;
  outcome:
    | "settled"
    | "already"
    | "still_pending"
    | "failed"
    | "under_review"
    | "unreachable"
    | "skipped";
  reason?: string;
}

export interface ReconcileSummary {
  examined: number;
  changed: number;
  /** Pagos que cruzaron la ventana y se cerraron o pasaron a revisión. */
  expired: number;
  results: ReconcileResult[];
}

interface PendingRow {
  payment_id: string;
  job_id: string;
  assignment_id: string | null;
  reference: string;
  status: string;
  provider: string;
  environment: string | null;
  buy_order: string | null;
  session_id: string | null;
  amount: number;
  attempt: number;
  created_at: string;
  reconciled_at: string | null;
  review_reason: string | null;
}

/**
 * Recorre la cola y resuelve lo que se pueda.
 *
 * `admin` tiene que ser el cliente con la clave de servicio: ni la consulta de
 * la cola ni el asentamiento son ejecutables por un usuario.
 */
export async function reconcilePayments(
  admin: SupabaseClient,
  options: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const provider = getPaymentProvider();

  if (!isReconcilable(provider)) {
    return { examined: 0, changed: 0, expired: 0, results: [] };
  }

  const pending = await loadQueue(admin, options);
  const results: ReconcileResult[] = [];
  let changed = 0;

  for (const row of pending) {
    // Un pago creado en integración no se pregunta jamás contra producción, ni
    // al revés: serían dos transacciones distintas con el mismo identificador.
    if (row.environment && row.environment !== provider.environment) {
      results.push({
        paymentId: row.payment_id,
        before: row.status,
        after: row.status,
        outcome: "skipped",
        reason: `el pago es del ambiente ${row.environment} y el proveedor activo es ${provider.environment}`,
      });
      continue;
    }

    const result = await reconcileOne(admin, provider, row);
    results.push(result);
    if (result.before !== result.after) changed += 1;
  }

  // Los que cruzaron la ventana: fuera de ella el proveedor ya no responde, así
  // que no tiene sentido preguntar. Se cierran o pasan a revisión, con evento y
  // auditoría. Sin esto se quedaban colgados para siempre, invisibles.
  const expired = options.paymentId ? 0 : await expireStale(admin);

  paymentLog({
    operation: "reconcile",
    result: `examinados:${pending.length} cambiados:${changed} expirados:${expired}`,
    environment: provider.environment,
  });

  return { examined: pending.length, changed, expired, results };
}

async function loadQueue(
  admin: SupabaseClient,
  options: ReconcileOptions,
): Promise<PendingRow[]> {
  if (options.paymentId) {
    const { data, error } = await admin
      .from("payments")
      .select(
        "id,job_id,assignment_id,status,provider,environment,buy_order,session_id,amount,attempt,created_at,reconciled_at,review_reason",
      )
      .eq("id", options.paymentId)
      .maybeSingle();
    if (error) throw new Error(`No se pudo leer el pago: ${error.message}`);
    if (!data) return [];
    const row = data as Record<string, unknown>;
    return [
      {
        payment_id: String(row.id),
        job_id: String(row.job_id),
        assignment_id: (row.assignment_id as string | null) ?? null,
        reference: "",
        status: String(row.status),
        provider: String(row.provider),
        environment: (row.environment as string | null) ?? null,
        buy_order: (row.buy_order as string | null) ?? null,
        session_id: (row.session_id as string | null) ?? null,
        amount: Number(row.amount),
        attempt: Number(row.attempt ?? 0),
        created_at: String(row.created_at),
        reconciled_at: (row.reconciled_at as string | null) ?? null,
        review_reason: (row.review_reason as string | null) ?? null,
      },
    ];
  }

  const { data, error } = await admin.rpc("payments_pending_reconciliation", {
    p_older_than_minutes: options.olderThanMinutes ?? 5,
    p_limit: options.limit ?? 50,
  });
  if (error) throw new Error(`No se pudo leer la cola de conciliación: ${error.message}`);
  return (data ?? []) as PendingRow[];
}

async function reconcileOne(
  admin: SupabaseClient,
  provider: ReturnType<typeof getPaymentProvider> & {
    environment: string;
    inspect: (token: string) => Promise<ProviderSnapshot>;
  },
  row: PendingRow,
): Promise<ReconcileResult> {
  // El token no sale de la cola: se lee aquí, con la clave de servicio, y no
  // se registra en ningún sitio sin enmascarar.
  const { data: tokenRow } = await admin
    .from("payments")
    .select("provider_token")
    .eq("id", row.payment_id)
    .maybeSingle<{ provider_token: string | null }>();

  const token = tokenRow?.provider_token;
  if (!token) {
    return {
      paymentId: row.payment_id,
      before: row.status,
      after: row.status,
      outcome: "skipped",
      reason: "sin token del proveedor",
    };
  }

  let snapshot: ProviderSnapshot;
  try {
    snapshot = await provider.inspect(token);
  } catch (error) {
    // Que el proveedor no conteste no cambia nada: el pago sigue en la cola y
    // se vuelve a intentar. Jamás se da por fallido por no poder preguntar.
    paymentLog({
      operation: "reconcile",
      result: "unreachable",
      paymentId: row.payment_id,
      token,
      errorCategory: errorCategory(error),
    });
    return {
      paymentId: row.payment_id,
      before: row.status,
      after: row.status,
      outcome: "unreachable",
      reason: errorCategory(error),
    };
  }

  await recordSnapshot(admin, row.payment_id, provider.id, snapshot);

  // Sigue en vuelo: el proveedor no ha cerrado la transacción. Se deja como
  // está y se volverá a preguntar.
  //
  // La condición mira `terminal`, no solo `INITIALIZED`: un estado ausente o
  // uno que no conocemos tampoco es una respuesta en firme, y cerrarlo como
  // fallido sería decidir por el banco antes que el banco.
  if (!snapshot.authorized && snapshot.terminal === false) {
    return {
      paymentId: row.payment_id,
      before: row.status,
      after: row.status,
      outcome: "still_pending",
    };
  }

  if (!snapshot.authorized) {
    const { error } = await admin.rpc("record_payment_abandonment", {
      p_payment_id: row.payment_id,
      p_provider: provider.id,
      p_failure_reason: "reconciled_not_authorized",
      p_details: {
        provider_status: snapshot.providerStatus,
        response_code: snapshot.responseCode,
      },
    });
    if (error) throw new Error(`No se pudo cerrar el pago no autorizado: ${error.message}`);

    paymentLog({
      operation: "reconcile",
      result: "not_authorized",
      paymentId: row.payment_id,
      token,
    });
    return {
      paymentId: row.payment_id,
      before: row.status,
      after: "FAILED",
      outcome: "failed",
    };
  }

  /* ------------------------------------------------------------ autorizado */

  const problems = findMismatches(
    {
      vci: snapshot.vci,
      amount: snapshot.amount,
      status: snapshot.providerStatus,
      buyOrder: snapshot.buyOrder,
      sessionId: snapshot.sessionId,
      cardLastDigits: snapshot.cardLastDigits,
      accountingDate: snapshot.accountingDate,
      transactionDate: snapshot.transactionDate,
      authorizationCode: snapshot.authorizationCode,
      paymentTypeCode: snapshot.paymentTypeCode,
      responseCode: snapshot.responseCode,
      installmentsAmount: snapshot.installmentsAmount,
      installmentsNumber: snapshot.installmentsNumber,
      balance: snapshot.balance,
    },
    {
      amount: row.amount,
      buyOrder: row.buy_order ?? "",
      sessionId: row.session_id ?? "",
    },
  );

  if (problems.length > 0) {
    await admin
      .from("payments")
      .update({ status: "UNDER_REVIEW", review_reason: problems.join(",") })
      .eq("id", row.payment_id)
      .in("status", ["PENDING", "CREATED", "AUTHORIZED"]);

    paymentLog({
      operation: "reconcile",
      result: "under_review",
      paymentId: row.payment_id,
      reason: problems.join(","),
    });
    return {
      paymentId: row.payment_id,
      before: row.status,
      after: "UNDER_REVIEW",
      outcome: "under_review",
      reason: problems.join(","),
    };
  }

  const settlement = await applyProviderResult(admin, row.payment_id, provider.id, {
    providerTransactionId: snapshot.token,
    // La MISMA clave que usaría el retorno. Es lo que hace que conciliar un
    // pago ya asentado no produzca un segundo evento financiero.
    providerEventId: `commit:${snapshot.token}`,
    status: "PAID",
    amount: { amount: snapshot.amount ?? row.amount, currency: "CLP" },
    authorizationCode: snapshot.authorizationCode,
    cardLastDigits: snapshot.cardLastDigits,
    paymentTypeCode: snapshot.paymentTypeCode,
    installments: snapshot.installmentsNumber,
    transactionDate: snapshot.transactionDate,
    raw: snapshot.raw,
  });

  paymentLog({
    operation: "reconcile",
    result: settlement.paymentStatus,
    paymentId: row.payment_id,
    token,
    duplicate: settlement.outcome === "duplicate",
  });

  return {
    paymentId: row.payment_id,
    before: row.status,
    after: settlement.paymentStatus,
    outcome: settlement.outcome === "duplicate" ? "already" : "settled",
    reason: settlement.reviewReason ?? undefined,
  };
}

/**
 * Cierra los pagos que cruzaron la ventana de conciliación.
 *
 * La ventana vive en `platform_settings.reconciliation_window_days` —siete días
 * por defecto, que es lo que responde Webpay— y no en el código.
 *
 * Los que estaban `PENDING` o `CREATED` se cierran como fallidos: el token de
 * Webpay muere a los cinco minutos, así que a los siete días no hubo cobro y el
 * cliente queda libre para volver a pagar. Los que estaban `AUTHORIZED` pasan a
 * revisión, porque ahí sí puede haber dinero y no se cierra solo.
 */
async function expireStale(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin.rpc("expire_stale_payments", { p_limit: 100 });
  if (error) {
    paymentLog({ operation: "reconcile", result: "expire_failed", reason: error.message });
    return 0;
  }
  const rows = (data ?? []) as { payment_id: string; now_status: string }[];
  for (const row of rows) {
    paymentLog({
      operation: "reconcile",
      result: `expired:${row.now_status}`,
      paymentId: row.payment_id,
    });
  }
  return rows.length;
}
