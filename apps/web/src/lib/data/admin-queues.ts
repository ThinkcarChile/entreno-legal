/**
 * Qué pide una acción en el panel y qué ya es historia.
 *
 * Se define al revés de lo intuitivo: lo cerrado se enumera y lo accionable es
 * «todo lo demás». Si mañana aparece un estado nuevo, cae en la lista de
 * pendientes, que es visible siempre, y no en el historial paginado, donde
 * podría quedar en la página doce sin que nadie lo vea.
 */

/** Payouts terminados: transferidos o cancelados. `PayoutActions` no ofrece nada sobre ellos. */
export const CLOSED_PAYOUT_STATUSES = ["PAID", "CANCELLED"] as const;

/** Disputas terminadas. Una resuelta con devolución pendiente sigue pidiendo una acción. */
export const CLOSED_DISPUTE_STATUSES = ["RESOLVED", "WITHDRAWN"] as const;

/** Lista para `.not("status", "in", …)` de PostgREST. */
export function postgrestList(values: readonly string[]): string {
  return `(${values.join(",")})`;
}

export function isPayoutClosed(status: string): boolean {
  return (CLOSED_PAYOUT_STATUSES as readonly string[]).includes(status);
}

export function isDisputeClosed(status: string): boolean {
  return (CLOSED_DISPUTE_STATUSES as readonly string[]).includes(status);
}

export interface RefundRow {
  dispute_id: string | null;
  amount: number;
  status: string;
}

/**
 * Lo devuelto de verdad por cada disputa: solo las devoluciones `CONFIRMED`.
 * Pedirla (`REQUESTED`) o no saber cómo terminó no devuelve nada.
 */
export function confirmedRefundsByDispute(rows: readonly RefundRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row.dispute_id || row.status !== "CONFIRMED") continue;
    totals.set(row.dispute_id, (totals.get(row.dispute_id) ?? 0) + Number(row.amount));
  }
  return totals;
}

/**
 * Cuánto falta devolver de una disputa resuelta a favor del cliente. Cero si no
 * se le debe nada o si ya se devolvió todo.
 */
export function pendingDisputeRefund(refundAmount: number | null, confirmed: number): number {
  if (!refundAmount || refundAmount <= 0) return 0;
  return Math.max(refundAmount - Math.max(confirmed, 0), 0);
}

/* ------------------------------------------------------------- pagos */

/**
 * Filtros de `/admin/pagos`, con la misma regla que payouts y disputas.
 *
 * «En revisión» y «Sin resolver» piden una acción: se traen enteros, del más
 * antiguo al más reciente. «Todos» y «Devueltos» son historial: por páginas,
 * del más reciente al más antiguo. Antes los cuatro eran los cien más
 * recientes, y un pago en revisión de hace meses no aparecía en ninguno.
 */
export const ACTIONABLE_PAYMENT_FILTERS = ["review", "pending"] as const;
export const PAYMENT_HISTORY_FILTERS = ["all", "refunded"] as const;

export type ActionablePaymentFilter = (typeof ACTIONABLE_PAYMENT_FILTERS)[number];
export type PaymentHistoryFilter = (typeof PAYMENT_HISTORY_FILTERS)[number];
export type PaymentFilter = ActionablePaymentFilter | PaymentHistoryFilter;

/** «Sin resolver»: el cobro todavía puede confirmarse, fallar o vencer. */
export const UNRESOLVED_PAYMENT_STATUSES = ["PENDING", "CREATED", "AUTHORIZED"] as const;

/** «Devueltos», entero o en parte. */
export const REFUNDED_PAYMENT_STATUSES = ["REFUNDED", "PARTIALLY_REFUNDED"] as const;

/** `?filtro=` de la URL. Lo que no se reconoce es «Todos». */
export function parsePaymentFilter(value: string | string[] | null | undefined): PaymentFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  const known: readonly string[] = [...ACTIONABLE_PAYMENT_FILTERS, ...PAYMENT_HISTORY_FILTERS];
  return raw && known.includes(raw) ? (raw as PaymentFilter) : "all";
}

export function isActionablePaymentFilter(filter: PaymentFilter): filter is ActionablePaymentFilter {
  return (ACTIONABLE_PAYMENT_FILTERS as readonly string[]).includes(filter);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Un identificador en la URL (`?pago=`). Solo un uuid: con cualquier otra cosa
 * PostgREST respondería 400 y la pantalla entera fallaría, así que se ignora.
 */
export function parseUuidParam(value: string | string[] | null | undefined): string | null {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  return raw && UUID.test(raw) ? raw.toLowerCase() : null;
}

/**
 * Ordena `rows` como `ids`, que es el orden que dio la base. Las filas se
 * leen por trozos con `.in()`, que no conserva ningún orden; una fila sin
 * lugar en `ids` va al final, en el orden en que llegó.
 */
export function orderByIds<T>(rows: readonly T[], ids: readonly string[], idOf: (row: T) => string): T[] {
  const position = new Map(ids.map((id, index) => [id, index]));
  return rows
    .map((row, index) => ({ row, at: position.get(idOf(row)) ?? ids.length + index }))
    .sort((a, b) => a.at - b.at)
    .map(({ row }) => row);
}

export interface JobPaymentRow {
  id: string;
  status: string;
  created_at: string;
}

/** Estados de un pago que llegó a cobrarse. */
const CHARGED_PAYMENT_STATUSES: readonly string[] = [
  "PAID",
  "PARTIALLY_REFUNDED",
  "UNDER_REVIEW",
  "REFUNDED",
];

/**
 * El pago del TRABAJO de una asignación que llegó a cobrarse —el más reciente,
 * si hubo reintentos—, o el último si ninguno.
 *
 * Es el destino del enlace «Devolución pendiente» de `/admin/disputas` cuando
 * la cola no reparte la deuda de la disputa sobre ningún cobro (todo lo que
 * debía ya está pedido y falta que el banco lo confirme): ahí se ve la
 * devolución abierta. Cuando sí la reparte, manda `disputeRefundTarget`.
 */
export function disputePaymentId(jobPayments: readonly JobPaymentRow[]): string | null {
  const ranked = [...jobPayments].sort((a, b) => {
    const charged =
      Number(CHARGED_PAYMENT_STATUSES.includes(b.status)) -
      Number(CHARGED_PAYMENT_STATUSES.includes(a.status));
    if (charged !== 0) return charged;
    const time = Date.parse(b.created_at) - Date.parse(a.created_at);
    if (time !== 0) return time;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return ranked[0]?.id ?? null;
}

/* ------------------------------------------------ devolución de una disputa */

/**
 * Una fila de la cola «En revisión» con la parte de una disputa sobre un cobro
 * (`admin_payment_review_queue`, migración 20260601001610).
 */
export interface DisputeShareRow {
  payment_id: string;
  created_at: string;
  dispute_refund_pending: number;
}

/**
 * El cobro al que lleva «Devolución pendiente» en `/admin/disputas`: el
 * primero que tiene parte de la deuda, en el orden en que la base la reparte
 * (`app_private.dispute_refund_allocation`): el del trabajo antes que el del
 * tiempo adicional, después el más antiguo, y a igual hora el id menor.
 * `null` si ningún cobro tiene parte.
 */
export function disputeRefundTarget(
  shares: readonly DisputeShareRow[],
  jobPaymentIds: ReadonlySet<string>,
): string | null {
  const ranked = shares
    .filter((share) => Number(share.dispute_refund_pending) > 0)
    .sort((a, b) => {
      const job = Number(jobPaymentIds.has(b.payment_id)) - Number(jobPaymentIds.has(a.payment_id));
      if (job !== 0) return job;
      const time = Date.parse(a.created_at) - Date.parse(b.created_at);
      if (time !== 0) return time;
      return a.payment_id < b.payment_id ? -1 : a.payment_id > b.payment_id ? 1 : 0;
    });
  return ranked[0]?.payment_id ?? null;
}

/**
 * La disputa a la que se liga una devolución pedida desde la tarjeta de un
 * cobro en `/admin/pagos`: solo la que la cola reparte sobre ESE cobro, y solo
 * mientras le quede algo por pedir. Nunca la de la vista (`admin_payments`
 * toma la disputa de la asignación con un `limit 1`, también sobre el cobro
 * del tiempo adicional y con la disputa todavía abierta): ligar ahí una
 * devolución gastaba la deuda de la disputa en otro cobro, o la base la
 * rechazaba por estar abierta.
 */
export function refundDisputeId(payment: {
  disputeRefundPending: number;
  disputeRefundId: string | null;
}): string | null {
  return payment.disputeRefundPending > 0 ? payment.disputeRefundId : null;
}
