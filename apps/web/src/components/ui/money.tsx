import { cn } from "@/lib/utils/cn";
import { formatHourlyRate, formatMoney, formatMoneyRange, type Money } from "@/lib/utils/money";

/**
 * Presentación de montos.
 *
 * Toda cifra en pantalla pasa por aquí, para que el formato chileno sea consistente
 * y nunca se imprima un número crudo.
 */

export function Amount({ value, className }: { value: Money; className?: string }) {
  return <span className={cn("tabular-nums", className)}>{formatMoney(value)}</span>;
}

export function HourlyRate({ value, className }: { value: Money; className?: string }) {
  return <span className={cn("tabular-nums", className)}>{formatHourlyRate(value)}</span>;
}

export function AmountRange({
  min,
  max,
  className,
}: {
  min: Money;
  max: Money;
  className?: string;
}) {
  return <span className={cn("tabular-nums", className)}>{formatMoneyRange(min, max)}</span>;
}
