import type { SupabaseClient } from "@supabase/supabase-js";

import { getPaymentProviderForExistingPayments } from "./index";
import { errorCategory, paymentLog } from "./logging";
import {
  findTargetByToken,
  handleReturn,
  resolveFromSnapshot,
  type ReturnOutcome,
} from "./return-handler";
import { isReconcilable, type PaymentProvider, type ReconcilableProvider } from "./provider";

/**
 * Conciliación.
 *
 * Existe porque **Webpay Plus no tiene webhooks**. No se inventa uno: la única
 * fuente de verdad sobre una transacción es el retorno, el `commit` y la
 * consulta de estado. Si el navegador de quien paga muere entre el formulario
 * y el retorno —se le acaba la batería, cambia de red, cierra la pestaña—
 * nadie le va a contar a la plataforma lo que pasó. Hay que preguntarlo.
 *
 * Esta función pregunta. Toma los pagos sin estado final y, además, los
 * intentos anteriores de cada pago que nunca se resolvieron —el token de una
 * pestaña de Webpay que quedó abierta, o el de un `commit` que se cortó en la
 * red antes de que el cliente volviera a pagar—. Consulta su estado real en el
 * proveedor y los asienta por la MISMA vía que el retorno:
 * `confirm_payment_result`, con sus bloqueos y sus invariantes. No hay un
 * camino corto que salte las comprobaciones porque el dinero se haya
 * encontrado por aquí. Un intento anterior autorizado sobre un pago que ya
 * tenía su dinero queda registrado como cobro duplicado, para devolverlo.
 *
 * Es idempotente de punta a punta: la clave del evento es la misma que usaría
 * el `commit` del mismo token, así que conciliar un pago ya asentado por el
 * retorno no crea un segundo evento, ni un segundo pago al trabajador, ni una
 * segunda notificación.
 *
 * Webpay responde por una transacción durante **7 días**. Pasado ese plazo, un
 * pago o un intento sin resolver ya no se puede conciliar automáticamente y
 * necesita a una persona; `expire_stale_payments` lo lleva hasta ella.
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
  /** Número del intento, cuando lo conciliado es un intento anterior del pago. */
  attempt?: number;
  before: string;
  after: string;
  outcome:
    | "settled"
    | "already"
    | "still_pending"
    | "failed"
    | "under_review"
    | "double_charge"
    | "unreachable"
    | "skipped";
  reason?: string;
}

export interface ReconcileSummary {
  /** Transacciones consultadas: las de los pagos y las de sus intentos anteriores. */
  examined: number;
  changed: number;
  /** Pagos que cruzaron la ventana y se cerraron o pasaron a revisión. */
  expired: number;
  /** De las examinadas, cuántas eran intentos anteriores (ya no vigentes). */
  attemptsExamined: number;
  /** Cobros duplicados descubiertos en esta pasada: hay que devolverlos. */
  doubleCharges: number;
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

interface PendingAttemptRow {
  attempt_id: string;
  payment_id: string;
  attempt: number;
  payment_status: string;
  provider: string;
  environment: string | null;
  buy_order: string;
  created_at: string;
}

type Reconcilable = PaymentProvider & ReconcilableProvider;

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
  const provider = getPaymentProviderForExistingPayments();

  if (!isReconcilable(provider)) {
    return { examined: 0, changed: 0, expired: 0, attemptsExamined: 0, doubleCharges: 0, results: [] };
  }

  const pending = await loadQueue(admin, options);
  const results: ReconcileResult[] = [];

  for (const row of pending) {
    // Un pago creado en integración no se pregunta jamás contra producción, ni
    // al revés: serían dos transacciones distintas con el mismo identificador.
    if (row.environment && row.environment !== provider.environment) {
      results.push(otherEnvironment(row.payment_id, row.status, row.environment, provider));
      continue;
    }
    results.push(await reconcileOne(admin, provider, row));
  }

  // Los intentos anteriores que nadie resolvió. Antes no existían para la
  // conciliación: su token se había sobrescrito.
  const attempts = await loadAttemptQueue(admin, options);
  for (const row of attempts) {
    if (row.environment && row.environment !== provider.environment) {
      results.push({
        ...otherEnvironment(row.payment_id, row.payment_status, row.environment, provider),
        attempt: row.attempt,
      });
      continue;
    }
    results.push(await reconcileAttempt(admin, provider, row));
  }

  // Los que cruzaron la ventana: fuera de ella el proveedor ya no responde, así
  // que no tiene sentido preguntar. Se cierran o pasan a revisión, con evento y
  // auditoría. Sin esto se quedaban colgados para siempre, invisibles.
  const expired = options.paymentId ? 0 : await expireStale(admin);

  const changed = results.filter((r) => r.before !== r.after).length;
  const doubleCharges = results.filter((r) => r.outcome === "double_charge").length;
  const examined = pending.length + attempts.length;

  paymentLog({
    operation: "reconcile",
    result:
      `examinados:${examined} intentos:${attempts.length} cambiados:${changed} ` +
      `duplicados:${doubleCharges} expirados:${expired}`,
    environment: provider.environment,
  });

  return {
    examined,
    changed,
    expired,
    attemptsExamined: attempts.length,
    doubleCharges,
    results,
  };
}

function otherEnvironment(
  paymentId: string,
  status: string,
  environment: string,
  provider: Reconcilable,
): ReconcileResult {
  return {
    paymentId,
    before: status,
    after: status,
    outcome: "skipped",
    reason: `el pago es del ambiente ${environment} y el proveedor activo es ${provider.environment}`,
  };
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

/**
 * Los intentos anteriores sin resolver. Si la cola no se puede leer, se dice
 * en el registro y la pasada sigue: lo ya conciliado de los pagos no se tira
 * por esto, y la próxima pasada lo vuelve a intentar.
 */
async function loadAttemptQueue(
  admin: SupabaseClient,
  options: ReconcileOptions,
): Promise<PendingAttemptRow[]> {
  const { data, error } = await admin.rpc("payment_attempts_pending_reconciliation", {
    p_older_than_minutes: options.olderThanMinutes ?? 5,
    p_limit: options.limit ?? 50,
    p_payment_id: options.paymentId ?? null,
  });
  if (error) {
    paymentLog({ operation: "reconcile", result: "attempts_queue_failed", reason: error.message });
    return [];
  }
  return (data ?? []) as PendingAttemptRow[];
}

/**
 * Antigüedad mínima del intento para que la conciliación lo CONFIRME.
 *
 * Webpay mantiene abierto su formulario hasta 10 minutos (documentación oficial,
 * «Timeout»). Confirmar antes podría cruzarse con alguien que todavía está
 * escribiendo su tarjeta. Pasado ese margen, un intento que nunca recibió
 * `commit` se confirma como lo haría el retorno.
 */
const COMMIT_AFTER_MS = 15 * 60_000;

/** Un token que hay que resolver: el vigente de un pago o el de un intento anterior. */
interface TokenToReconcile {
  paymentId: string;
  attempt?: number;
  before: string;
  token: string;
  committedAt: string | null;
  /**
   * Desde cuándo existe el token; de ahí se cuenta el margen para confirmar.
   * Es la fecha del intento, nunca la última escritura del pago.
   */
  since: string;
}

async function reconcileOne(
  admin: SupabaseClient,
  provider: Reconcilable,
  row: PendingRow,
): Promise<ReconcileResult> {
  // El token no sale de la cola: se lee aquí, con la clave de servicio, y no
  // se registra en ningún sitio sin enmascarar.
  const { data: tokenRow } = await admin
    .from("payments")
    .select("provider_token,committed_at,buy_order,created_at")
    .eq("id", row.payment_id)
    .maybeSingle<{
      provider_token: string | null;
      committed_at: string | null;
      buy_order: string | null;
      created_at: string;
    }>();

  if (!tokenRow?.provider_token) {
    return {
      paymentId: row.payment_id,
      before: row.status,
      after: row.status,
      outcome: "skipped",
      reason: "sin token del proveedor",
    };
  }

  return reconcileToken(admin, provider, {
    paymentId: row.payment_id,
    before: row.status,
    token: tokenRow.provider_token,
    committedAt: tokenRow.committed_at,
    since: await currentTokenSince(admin, row.payment_id, tokenRow),
  });
}

/**
 * Desde cuándo existe el token VIGENTE de un pago: el del intento que lleva su
 * orden de compra (cuando Webpay lo entregó o, sin esa marca, cuando se
 * registró el intento), igual que con un intento anterior.
 *
 * No `payments.updated_at`: `record_provider_snapshot` lo renueva en cada
 * pasada de la conciliación, y con el cron cada 15 minutos o menos el margen
 * para confirmar no se cumplía nunca. Sin intento en el historial (un pago
 * anterior a él), la creación del pago.
 */
async function currentTokenSince(
  admin: SupabaseClient,
  paymentId: string,
  payment: { buy_order: string | null; created_at: string },
): Promise<string> {
  if (!payment.buy_order) return payment.created_at;
  const { data: attempt } = await admin
    .from("payment_attempts")
    .select("token_at,created_at")
    .eq("payment_id", paymentId)
    .eq("buy_order", payment.buy_order)
    .maybeSingle<{ token_at: string | null; created_at: string }>();
  return attempt ? (attempt.token_at ?? attempt.created_at) : payment.created_at;
}

async function reconcileAttempt(
  admin: SupabaseClient,
  provider: Reconcilable,
  row: PendingAttemptRow,
): Promise<ReconcileResult> {
  const { data: tokenRow } = await admin
    .from("payment_attempts")
    .select("provider_token,committed_at,token_at,created_at")
    .eq("id", row.attempt_id)
    .maybeSingle<{
      provider_token: string | null;
      committed_at: string | null;
      token_at: string | null;
      created_at: string;
    }>();

  if (!tokenRow?.provider_token) {
    return {
      paymentId: row.payment_id,
      attempt: row.attempt,
      before: row.payment_status,
      after: row.payment_status,
      outcome: "skipped",
      reason: "sin token del proveedor",
    };
  }

  return reconcileToken(admin, provider, {
    paymentId: row.payment_id,
    attempt: row.attempt,
    before: row.payment_status,
    token: tokenRow.provider_token,
    committedAt: tokenRow.committed_at,
    since: tokenRow.token_at ?? tokenRow.created_at,
  });
}

async function reconcileToken(
  admin: SupabaseClient,
  provider: Reconcilable,
  item: TokenToReconcile,
): Promise<ReconcileResult> {
  // Nunca confirmado: se CONFIRMA antes de solo consultar.
  //
  // La documentación del proyecto (PAGOS.md §9.4) dice que una autorización
  // sin confirmar se revierte sola; la oficial no lo aclara. Confirmar es
  // correcto en los dos casos: si no hacía falta, el proveedor contesta que ya
  // está resuelta y se sigue con la consulta de estado de siempre. Se usa el
  // mismo camino que el retorno (`handleReturn`), con sus bloqueos y su clave
  // de idempotencia `commit:<token>`, así que no hay un segundo modo de asentar.
  // Vale igual para el token de un intento anterior: `handleReturn` lo busca
  // en el historial.
  if (!item.committedAt && Date.now() - new Date(item.since).getTime() > COMMIT_AFTER_MS) {
    try {
      const outcome = await handleReturn(admin, { kind: "NORMAL", token: item.token }, null);
      if (outcome.kind !== "PENDING" && outcome.kind !== "NOT_FOUND" && outcome.kind !== "FORBIDDEN") {
        return resultOf(admin, item, outcome, "confirmado por la conciliación");
      }
      // PENDING u otro: sin respuesta en firme, se sigue con la consulta.
    } catch (error) {
      paymentLog({
        operation: "reconcile",
        result: "commit_failed",
        paymentId: item.paymentId,
        token: item.token,
        errorCategory: errorCategory(error),
      });
    }
  }

  const target = await findTargetByToken(admin, item.token);
  if (!target) {
    return {
      paymentId: item.paymentId,
      attempt: item.attempt,
      before: item.before,
      after: item.before,
      outcome: "skipped",
      reason: "el token ya no corresponde a ningún pago",
    };
  }

  let snapshot;
  try {
    snapshot = await provider.inspect(item.token);
  } catch (error) {
    // Que el proveedor no conteste no cambia nada: el pago sigue en la cola y
    // se vuelve a intentar. Jamás se da por fallido por no poder preguntar.
    paymentLog({
      operation: "reconcile",
      result: "unreachable",
      paymentId: item.paymentId,
      token: item.token,
      errorCategory: errorCategory(error),
    });
    return {
      paymentId: item.paymentId,
      attempt: item.attempt,
      before: item.before,
      after: item.before,
      outcome: "unreachable",
      reason: errorCategory(error),
    };
  }

  // Autorizada, en vuelo o cerrada sin autorizar: lo decide el mismo código
  // que el retorno, sobre el intento al que pertenece el token. Un descuadre
  // va a revisión sin pasar por PAID; un intento anterior rechazado no cierra
  // el pago.
  const outcome = await resolveFromSnapshot(
    admin,
    provider.id,
    target,
    snapshot,
    "reconciled_not_authorized",
    { source: "reconcile" },
  );

  paymentLog({
    operation: "reconcile",
    result: outcome.kind.toLowerCase(),
    paymentId: item.paymentId,
    token: item.token,
  });
  return resultOf(admin, item, outcome);
}

/** El resultado del retorno, en el idioma de la conciliación. */
async function resultOf(
  admin: SupabaseClient,
  item: TokenToReconcile,
  outcome: ReturnOutcome,
  note?: string,
): Promise<ReconcileResult> {
  const { data: after } = await admin
    .from("payments")
    .select("status")
    .eq("id", item.paymentId)
    .maybeSingle<{ status: string }>();
  const afterStatus = after?.status ?? item.before;

  let kind: ReconcileResult["outcome"];
  let reason = note;
  switch (outcome.kind) {
    case "DOUBLE_CHARGE":
      kind = "double_charge";
      reason = outcome.reason;
      break;
    case "REVIEW":
      kind = "under_review";
      reason = outcome.reason;
      break;
    case "ALREADY":
      kind = "already";
      break;
    case "PENDING":
      kind = "still_pending";
      break;
    case "ABANDONED":
      kind = "failed";
      break;
    case "SETTLED":
      kind =
        outcome.settlement.outcome === "duplicate"
          ? "already"
          : outcome.settlement.decision === "ATTEMPT_FAILED" || afterStatus === "FAILED"
            ? "failed"
            : "settled";
      reason = outcome.settlement.reviewReason ?? note;
      break;
    default:
      kind = "skipped";
  }

  return {
    paymentId: item.paymentId,
    attempt: item.attempt,
    before: item.before,
    after: afterStatus,
    outcome: kind,
    reason,
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
 * revisión, porque ahí sí puede haber dinero y no se cierra solo. Los intentos
 * anteriores que salieron de la ventana sin resolverse se cierran igual, cada
 * uno con su evento: a revisión si se pidió su commit.
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
