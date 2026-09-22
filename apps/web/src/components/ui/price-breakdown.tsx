import { cn } from "@/lib/utils/cn";
import { formatMoney } from "@/lib/utils/money";

import type { Money } from "@/lib/utils/money";

/**
 * Desglose de un precio.
 *
 * Un solo componente para las tres pantallas que muestran dinero —pago, trabajo
 * asignado, ganancias— porque un desglose que cuadra en una y no en otra es la
 * forma más rápida de perder la confianza que el producto vende.
 *
 * Los importes llegan calculados por la base. Aquí no se suma nada.
 */
export interface PriceLine {
  label: string;
  value: Money;
  /** Un descuento o una comisión: se muestra restando. */
  negative?: boolean;
  hint?: string;
}

export function PriceBreakdown({
  lines,
  total,
  totalLabel,
  note,
  className,
}: {
  lines: readonly PriceLine[];
  total: Money;
  totalLabel: string;
  note?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <dl className="space-y-2.5">
        {lines.map((line) => (
          <div key={line.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-small text-ink-600">
              {line.label}
              {line.hint && <span className="block text-caption text-ink-500">{line.hint}</span>}
            </dt>
            <dd
              className={cn(
                "shrink-0 text-small tabular-nums",
                line.negative ? "text-ink-500" : "text-ink-950",
              )}
            >
              {line.negative ? "− " : ""}
              {formatMoney(line.value)}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex items-baseline justify-between gap-4 border-t border-line pt-3">
        <span className="text-small font-medium text-ink-950">{totalLabel}</span>
        <span className="text-h3 text-ink-950 tabular-nums">{formatMoney(total)}</span>
      </div>

      {note && <p className="mt-3 text-caption text-ink-600">{note}</p>}
    </div>
  );
}
