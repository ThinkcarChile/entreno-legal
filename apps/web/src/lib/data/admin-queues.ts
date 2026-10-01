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
