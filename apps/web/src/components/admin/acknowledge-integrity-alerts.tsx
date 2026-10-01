"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui";
import { acknowledgeIntegrityAlertsAction } from "@/lib/actions/admin";

/**
 * «Marcar como vistas» de la alerta roja del resumen.
 *
 * Solo dice que alguien ya la leyó: la regla sigue rota, sigue en la lista y
 * el aviso diario sigue llegando hasta que se arregle el dato.
 */
export function AcknowledgeIntegrityAlerts() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-3">
      <Button
        variant="outline"
        size="sm"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await acknowledgeIntegrityAlertsAction();
            if (!result.ok) {
              setError(result.error);
              return;
            }
            router.refresh();
          })
        }
      >
        Marcar como vistas
      </Button>
      {error && (
        <p className="mt-1.5 text-caption" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
