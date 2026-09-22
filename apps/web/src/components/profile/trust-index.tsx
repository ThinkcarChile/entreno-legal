import { ShieldCheck } from "lucide-react";

import { Card, CardContent } from "@/components/ui";
import { site } from "@/config/site";
import { trustIndexBand, type TrustIndexResult } from "@/lib/reputation";
import { formatPercent } from "@/lib/utils/format";

/**
 * Índice de Confianza: no es un promedio de estrellas, es una lectura compuesta.
 * Se muestran los componentes para que la puntuación sea explicable.
 */
export function TrustIndexCard({ result }: { result: TrustIndexResult }) {
  const band = trustIndexBand(result.value);

  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-small font-medium text-ink-600">
              <ShieldCheck size={16} className="text-brand-600" aria-hidden="true" />
              {site.trustIndexLabel}
            </p>
            <p className="mt-2 text-4xl font-semibold tracking-tight text-ink-950 tabular-nums">
              {result.value}
              <span className="ml-1 text-lg font-normal text-ink-500">/100</span>
            </p>
            <p className="mt-1 text-small text-ink-500">{band.label}</p>
          </div>
        </div>

        <dl className="mt-6 space-y-3">
          {result.components.map((component) => (
            <div key={component.code}>
              <div className="flex items-center justify-between text-small">
                <dt className="text-ink-600">{component.label}</dt>
                <dd className="font-medium text-ink-950 tabular-nums">
                  {formatPercent(component.score)}
                </dd>
              </div>
              <div
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-100"
                role="presentation"
              >
                <div
                  className="h-full rounded-full bg-brand-600"
                  style={{ width: `${Math.round(component.score * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
