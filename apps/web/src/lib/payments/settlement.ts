import { platform } from "@/config/platform";
import { add, applyBps, money, subtract, zero, type Money } from "@/lib/utils/money";

/**
 * Liquidación de un trabajo: cuánto paga el cliente y cuánto recibe el trabajador.
 *
 * Conceptos separados a propósito:
 *  - PAGO POR TRABAJO: tiempo efectivamente comprometido, incluidas extensiones aceptadas.
 *  - BONO POR OBJETIVO: se paga solo si el objetivo se cumplió. Un factor externo puede
 *    impedir el objetivo sin afectar el pago por tiempo.
 *
 * El dinero entra a la cuenta comercial de HagoTuFila y queda asociado a un trabajo
 * específico. No existe billetera del cliente ni saldo retirable.
 */

export interface SettlementInput {
  /** Pago por trabajo ya acordado (tarifa × duración). */
  serviceAmount: Money;
  /** Extensiones aceptadas y pagadas. */
  extensionsAmount?: Money;
  /** Bono comprometido por el cliente. */
  bonusAmount?: Money;
  /** Si el objetivo se cumplió. `false` paga el tiempo pero no el bono. */
  bonusAwarded?: boolean;
  /** Comisión en puntos base. Por defecto, la de la plataforma. */
  commissionBps?: number;
  /** FilaPuntos aplicados como descuento sobre la comisión. */
  loyaltyPointsRedeemed?: number;
  /** Descuento adicional al trabajador, por ejemplo tras una disputa parcial. */
  workerDiscount?: Money;
  /** Retención o impuesto aplicado al trabajador, cuando corresponda. */
  taxWithheldBps?: number;
}

export interface SettlementResult {
  /** Total cobrado al cliente. */
  clientTotal: Money;
  /** Monto bruto del servicio destinado al trabajador antes de comisión. */
  grossAmount: Money;
  commissionAmount: Money;
  /** Descuento sobre la comisión financiado con FilaPuntos. */
  loyaltyDiscountAmount: Money;
  /** Ingreso efectivo de la plataforma. */
  platformRevenue: Money;
  bonusAmount: Money;
  workerDiscount: Money;
  taxWithheldAmount: Money;
  /** Monto final a transferir al trabajador. */
  netAmount: Money;
}

export function calculateSettlement(input: SettlementInput): SettlementResult {
  const currency = input.serviceAmount.currency;
  const extensions = input.extensionsAmount ?? zero(currency);
  const bonusCommitted = input.bonusAmount ?? zero(currency);
  const bonusAmount = input.bonusAwarded === false ? zero(currency) : bonusCommitted;

  const grossAmount = add(input.serviceAmount, extensions);
  const clientTotal = add(grossAmount, bonusAmount);

  const commissionBps = input.commissionBps ?? platform.commissionBps;
  const commissionAmount = applyBps(grossAmount, commissionBps);

  const loyaltyDiscountAmount = calculateLoyaltyDiscount(
    commissionAmount,
    input.loyaltyPointsRedeemed ?? 0,
  );
  const platformRevenue = subtract(commissionAmount, loyaltyDiscountAmount);

  const workerDiscount = input.workerDiscount ?? zero(currency);
  const beforeTax = subtract(
    subtract(add(grossAmount, bonusAmount), commissionAmount),
    workerDiscount,
  );
  const taxWithheldAmount = input.taxWithheldBps
    ? applyBps(beforeTax, input.taxWithheldBps)
    : zero(currency);

  return {
    clientTotal,
    grossAmount,
    commissionAmount,
    loyaltyDiscountAmount,
    platformRevenue,
    bonusAmount,
    workerDiscount,
    taxWithheldAmount,
    netAmount: subtract(beforeTax, taxWithheldAmount),
  };
}

/**
 * FilaPuntos solo descuentan comisión de HagoTuFila, con tope.
 * Nunca son dinero retirable ni reducen lo que recibe el trabajador.
 */
export function calculateLoyaltyDiscount(commission: Money, points: number): Money {
  if (points <= 0) return zero(commission.currency);
  const maxDiscount = applyBps(commission, platform.loyaltyMaxCommissionDiscountBps);
  const requested = money(points * platform.loyaltyPointValueClp, commission.currency);
  return requested.amount < maxDiscount.amount ? requested : maxDiscount;
}

/** FilaPuntos ganados por un trabajo completado. */
export function loyaltyPointsForJob(clientTotal: Money): number {
  return Math.floor((clientTotal.amount / 1000) * platform.loyaltyPointsPer1000Clp);
}
