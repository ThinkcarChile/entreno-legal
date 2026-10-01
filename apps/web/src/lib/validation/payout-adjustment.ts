import { formatMoney } from "@/lib/utils/money";

/**
 * Ajustar el pago a un trabajador (`public.adjust_payout`, migración
 * 20260601001610).
 *
 * La regla la impone la base: solo administración, solo un payout sin
 * transferir, solo hacia abajo, $0 lo cancela y el motivo es obligatorio. Esta
 * copia existe para que el formulario diga qué está mal antes de enviar y para
 * pedir la confirmación con las cifras exactas; si las dos se separan, manda la
 * base.
 */

/** Largo mínimo del motivo. El mismo que exige la base: lo lee el trabajador. */
export const MIN_ADJUSTMENT_REASON = 10;

export type PayoutAdjustmentCheck =
  | { ok: true; netAmount: number; cancels: boolean }
  | { ok: false; error: string; field: "netAmount" | "reason" };

const clp = (amount: number) => formatMoney({ amount, currency: "CLP" });

/**
 * ¿Se puede pedir este ajuste? `netAmount` llega del formulario: un número de
 * pesos, entero, entre cero y el neto actual, y distinto de él.
 */
export function checkPayoutAdjustment(
  currentNet: number,
  netAmount: number,
  reason: string,
): PayoutAdjustmentCheck {
  if (!Number.isInteger(netAmount) || netAmount < 0) {
    return {
      ok: false,
      error: "El nuevo neto es un número entero de pesos, cero o más.",
      field: "netAmount",
    };
  }
  if (netAmount > currentNet) {
    return {
      ok: false,
      error: `Un ajuste solo baja el neto: hoy es ${clp(currentNet)}. Subirlo es un caso para soporte.`,
      field: "netAmount",
    };
  }
  if (netAmount === currentNet) {
    return {
      ok: false,
      error: `${clp(currentNet)} es el neto actual: no hay nada que ajustar.`,
      field: "netAmount",
    };
  }
  if (reason.trim().length < MIN_ADJUSTMENT_REASON) {
    return {
      ok: false,
      error: `Escribe el motivo (al menos ${MIN_ADJUSTMENT_REASON} caracteres): lo lee el trabajador.`,
      field: "reason",
    };
  }
  return { ok: true, netAmount, cancels: netAmount === 0 };
}

/** Lo que se confirma, con las dos cifras. */
export function adjustmentSummary(currentNet: number, netAmount: number): string {
  return netAmount === 0
    ? `Se cancela el pago de ${clp(currentNet)}: el trabajador no recibirá nada por este trabajo.`
    : `El trabajador recibirá ${clp(netAmount)} en vez de ${clp(currentNet)}.`;
}
