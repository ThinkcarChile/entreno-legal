"use client";

import { useState, useTransition } from "react";

import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui";
import { reconcilePaymentsAction } from "@/lib/actions/finance";

/**
 * Conciliar la cola entera.
 *
 * El mismo servicio que ejecutaría una tarea programada, invocado a mano.
 * Mientras no haya programador en el hosting, este botón es la forma de
 * cerrar los pagos que se quedaron colgados.
 */
export function ReconcileAll() {
  const [pending, startTransition] = useTransition();
  const [summary, setSummary] = useState<string | null>(null);

  return (
    <div className="text-right">
      <Button
        variant="outline"
        onClick={() =>
          startTransition(async () => {
            const result = await reconcilePaymentsAction();
            setSummary(
              result.ok
                ? `${result.data.examined} revisados · ${result.data.changed} actualizados`
                : result.error,
            );
          })
        }
        loading={pending}
      >
        <RefreshCw size={16} aria-hidden="true" />
        Conciliar pendientes
      </Button>
      {summary && (
        <p className="mt-1.5 text-caption text-ink-600" role="status">
          {summary}
        </p>
      )}
    </div>
  );
}
