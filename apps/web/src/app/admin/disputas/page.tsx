import type { Metadata } from "next";
import Link from "next/link";

import { ShieldCheck } from "lucide-react";

import { DisputeResolutionForm } from "@/components/admin/dispute-resolution";
import { Amount, Badge, Card, CardContent, EmptyState } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { requireAdmin } from "@/lib/auth/session";
import { getData } from "@/lib/data";
import { DisputeStatus } from "@/lib/domain/enums";
import { disputeStatusLabels } from "@/lib/domain/labels";
import { isDisputeOpen } from "@/lib/domain/permissions";
import { formatDateTime } from "@/lib/utils/datetime";

export const metadata: Metadata = {
  title: "Disputas",
  robots: { index: false, follow: false },
};

/**
 * Disputas.
 *
 * Mientras una está abierta, el pago al trabajador queda retenido y el cliente
 * no puede aprobar el trabajo. Las dos cosas las impone la base, no esta
 * pantalla; aquí solo se decide.
 */
export default async function AdminDisputesPage() {
  await requireAdmin("/admin/disputas");
  const rows = await getData().admin.listDisputes();

  const open = rows.filter((r) => isDisputeOpen(r.dispute.status));
  const resolved = rows.filter((r) => !isDisputeOpen(r.dispute.status));

  return (
    <div className="container-page py-8 sm:py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Disputas</h1>
        <p className="mt-1 text-ink-600">
          {open.length} abierta{open.length === 1 ? "" : "s"} · {resolved.length} resuelta
          {resolved.length === 1 ? "" : "s"}
        </p>
      </header>

      <Alert tone="warning" className="mt-5" title="Lo que una resolución hace y lo que no">
        Define la liberación de fondos dentro de la plataforma y deja anotado el monto a devolver
        al cliente. No ejecuta ningún reembolso bancario: eso requiere la integración con el medio
        de pago.
      </Alert>

      {rows.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<ShieldCheck size={22} className="text-ink-400" aria-hidden="true" />}
            title="Sin disputas"
            description="No hay reclamos abiertos ni resueltos."
          />
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {[...open, ...resolved].map((row) => {
            const label = disputeStatusLabels[row.dispute.status];
            return (
              <li key={row.dispute.id}>
                <Card>
                  <CardContent className="space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={label.tone}>{label.label}</Badge>
                          <span className="text-xs text-ink-400">{row.jobReference}</span>
                        </div>
                        <p className="mt-1.5 font-medium text-ink-900">{row.jobTitle}</p>
                        <p className="mt-0.5 text-sm text-ink-600">
                          {row.clientName} (cliente) · {row.workerName} (trabajador) ·{" "}
                          {formatDateTime(row.dispute.createdAt)}
                        </p>
                      </div>
                      {row.amountHeld && (
                        <p className="shrink-0 text-right">
                          <span className="block text-xs text-ink-500">Monto en juego</span>
                          <span className="text-lg font-semibold text-ink-900 tabular-nums">
                            <Amount value={row.amountHeld} />
                          </span>
                        </p>
                      )}
                    </div>

                    <div className="rounded-[var(--radius-control)] bg-ink-50 p-3.5 text-sm">
                      <p className="font-medium text-ink-900">{row.dispute.reason}</p>
                      <p className="mt-1 text-ink-700">{row.dispute.description}</p>
                    </div>

                    {row.dispute.status === DisputeStatus.RESOLVED ? (
                      <div className="rounded-[var(--radius-control)] bg-success-50 p-3.5 text-sm text-success-800">
                        <p className="font-medium">Resuelta: {row.dispute.resolution}</p>
                        <p className="mt-1">{row.dispute.resolutionNotes}</p>
                        {row.dispute.refundAmount && row.dispute.refundAmount.amount > 0 && (
                          <p className="mt-1">
                            Monto a devolver al cliente:{" "}
                            <Amount value={row.dispute.refundAmount} /> · pendiente de procesar.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-start gap-3">
                        <Link
                          href={`/mis-trabajos/${row.dispute.assignmentId}`}
                          className="text-sm font-medium text-brand-700 underline underline-offset-2"
                        >
                          Ver el trabajo y su evidencia
                        </Link>
                        <DisputeResolutionForm disputeId={row.dispute.id} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
