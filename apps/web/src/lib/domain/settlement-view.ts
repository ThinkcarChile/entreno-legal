import { PaymentStatus } from "./enums";
import type { Money } from "@/lib/utils/money";

import type { Payment, PaymentBreakdown, Payout } from "./types";

/** Estados en que el cobro llegó a hacerse (aunque después se devuelva o se revise). */
const CHARGED: ReadonlySet<string> = new Set([
  PaymentStatus.PAID,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
  PaymentStatus.UNDER_REVIEW,
]);

export interface SettlementHeadline {
  /** Lo que se le cobró al cliente: el trabajo más el tiempo adicional cobrado. */
  clientCharged: Money;
  /** La parte de eso que es tiempo adicional (0 si no hubo). */
  extensionCharged: Money;
  /** Lo que recibe el trabajador: el payout si ya existe; si no, lo acordado. */
  workerReceives: Money;
  /** true cuando `workerReceives` sale del payout y no de lo acordado. */
  fromPayout: boolean;
}

/**
 * Las cifras de cabecera de una asignación.
 *
 * Antes salían solo de `settlement`, que es lo acordado al aceptar la oferta:
 * el cliente veía «Total pagado $18.000» con $36.000 cobrados (el trabajo y
 * una extensión), y el trabajador seguía viendo $15.480 después de un ajuste o
 * de una resolución parcial que le dejó $7.480. Lo cobrado sale de los pagos;
 * lo que recibe el trabajador, del payout cuando existe.
 */
export function settlementHeadline(input: {
  settlement: PaymentBreakdown;
  payment: Pick<Payment, "status" | "amount"> | null;
  extensionPayments: Readonly<Record<string, Pick<Payment, "status" | "amount">>>;
  payout: Pick<Payout, "netAmount"> | null;
}): SettlementHeadline {
  const currency = input.settlement.clientTotal.currency;
  const charged = (p: Pick<Payment, "status" | "amount"> | null) =>
    p && CHARGED.has(p.status) ? p.amount.amount : 0;

  const extension = Object.values(input.extensionPayments).reduce((sum, p) => sum + charged(p), 0);
  const jobCharged = charged(input.payment);
  const clientCharged = jobCharged > 0 ? jobCharged + extension : input.settlement.clientTotal.amount;

  return {
    clientCharged: { amount: clientCharged, currency },
    extensionCharged: { amount: extension, currency },
    workerReceives: input.payout ? input.payout.netAmount : input.settlement.workerReceives,
    fromPayout: input.payout !== null,
  };
}
