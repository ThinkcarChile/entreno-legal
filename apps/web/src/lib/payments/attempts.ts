/**
 * Un intento de pago, tal como queda en `payment_attempts`.
 *
 * El pago guarda el token del intento VIGENTE; los anteriores siguen aquí. Es
 * lo que permite reconocer el retorno de una pestaña de Webpay que quedó
 * abierta, o confirmar un cobro cuyo `commit` se cortó en la red, aunque el
 * cliente haya vuelto a pagar después. Se lee y se escribe solo con la clave
 * de servicio: ningún usuario ve el token.
 */
export interface AttemptRow {
  id: string;
  payment_id: string;
  attempt: number;
  /** CREATED, FAILED, SETTLED, DOUBLE_CHARGE o UNDER_REVIEW. */
  status: string;
  buy_order: string;
  session_id: string | null;
  provider_token: string | null;
  commit_requested_at: string | null;
  committed_at: string | null;
  created_at: string;
  token_at: string | null;
}

export const ATTEMPT_COLUMNS =
  "id,payment_id,attempt,status,buy_order,session_id,provider_token," +
  "commit_requested_at,committed_at,created_at,token_at";

/** Estados de un intento que ya tienen dinero detrás: no se vuelven a confirmar. */
export const ATTEMPT_STATUSES_WITH_MONEY: readonly string[] = [
  "SETTLED",
  "DOUBLE_CHARGE",
  "UNDER_REVIEW",
];
