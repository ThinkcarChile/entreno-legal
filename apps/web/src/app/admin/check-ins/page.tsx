import type { Metadata } from "next";
import Link from "next/link";

import { MapPinOff } from "lucide-react";

import { CheckInReviewActions } from "@/components/admin/check-in-review";
import { Badge, Card, CardContent, EmptyState } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { requireAdmin } from "@/lib/auth/session";
import { getData } from "@/lib/data";
import { CheckInResult } from "@/lib/domain/enums";
import { formatDateTime } from "@/lib/utils/datetime";

export const metadata: Metadata = {
  title: "Llegadas por revisar",
  robots: { index: false, follow: false },
};

const RESULT_LABEL: Record<string, { label: string; detail: string }> = {
  [CheckInResult.OUT_OF_RANGE]: {
    label: "Fuera de rango",
    detail: "La ubicación quedó lejos del lugar del trabajo.",
  },
  [CheckInResult.LOW_ACCURACY]: {
    label: "Poca precisión",
    detail: "El teléfono no pudo ubicarse con precisión suficiente.",
  },
  [CheckInResult.NO_LOCATION]: {
    label: "Sin ubicación",
    detail: "La llegada se registró sin datos de ubicación.",
  },
};

/**
 * Llegadas que no se verificaron solas.
 *
 * El trabajo no puede comenzar hasta que alguien mire esto, así que la cola es
 * urgente por definición. Aquí no se ven coordenadas: se ve la distancia y el
 * motivo, que es lo que hace falta para decidir.
 */
export default async function AdminCheckInsPage() {
  await requireAdmin("/admin/check-ins");
  const rows = await getData().admin.listPendingCheckIns();

  return (
    <div className="container-page py-8 sm:py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Llegadas por revisar</h1>
        <p className="mt-1 text-ink-600">
          Check-ins que no se verificaron automáticamente. Mientras estén aquí, el trabajador no
          puede comenzar.
        </p>
      </header>

      <Alert tone="info" className="mt-5" title="Qué se ve y qué no">
        Se muestran la distancia calculada y el motivo, nunca las coordenadas del trabajador.
        Comprobar la ubicación no descarta un GPS falseado: si hay dudas, pide evidencia por el
        chat del trabajo antes de aprobar.
      </Alert>

      <div className="mt-6">
        {rows.length === 0 ? (
          <EmptyState
            icon={<MapPinOff size={22} className="text-ink-400" aria-hidden="true" />}
            title="Nada por revisar"
            description="Todas las llegadas registradas se verificaron solas."
          />
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => {
              const meta = RESULT_LABEL[row.result] ?? {
                label: row.result,
                detail: "",
              };
              return (
                <li key={row.id}>
                  <Card>
                    <CardContent className="flex flex-wrap items-start justify-between gap-5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone="warning">{meta.label}</Badge>
                          <span className="text-xs text-ink-400">{row.jobReference}</span>
                        </div>
                        <Link
                          href={`/mis-trabajos/${row.assignmentId}`}
                          className="mt-1.5 block font-medium text-ink-900 hover:text-brand-700"
                        >
                          {row.jobTitle}
                        </Link>
                        <p className="mt-0.5 text-sm text-ink-600">
                          {row.workerName} · {formatDateTime(row.occurredAt)}
                        </p>
                        <p className="mt-1 text-sm text-ink-500">
                          {row.distanceM != null
                            ? `A ${row.distanceM} m del lugar. `
                            : "Sin distancia calculada. "}
                          {row.reviewReason ?? meta.detail}
                        </p>
                      </div>
                      <CheckInReviewActions checkInId={row.id} />
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
