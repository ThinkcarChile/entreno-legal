import type { Metadata } from "next";
import Link from "next/link";

import { Banknote } from "lucide-react";

import { PayoutActions } from "@/components/admin/payout-actions";
import { Amount, Badge, Card, CardContent, EmptyState } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { requireAdmin } from "@/lib/auth/session";
import { getData } from "@/lib/data";
import { payoutStatusLabels } from "@/lib/domain/labels";
import { formatDateTime } from "@/lib/utils/datetime";

export const metadata: Metadata = {
  title: "Pagos a trabajadores",
  robots: { index: false, follow: false },
};

/**
 * Pagos a trabajadores.
 *
 * La transferencia es manual y se registra con su referencia bancaria. Nada de
 * lo que ocurre aquí mueve dinero: lo anota.
 */
export default async function AdminPayoutsPage() {
  await requireAdmin("/admin/payouts");
  const rows = await getData().admin.listPayouts();

  return (
    <div className="container-page py-8 sm:py-10">
      <header>
        <h1 className="text-h2 text-ink-950">
          Pagos a trabajadores
        </h1>
        <p className="mt-1 text-ink-600">
          Se aprueban cuando el cliente da el trabajo por bueno, y se transfieren a mano.
        </p>
      </header>

      <Alert tone="info" className="mt-5" title="Transferencia manual">
        La plataforma no envía dinero. «Registrar transferencia» anota un pago hecho por fuera, con
        su referencia bancaria, para que quede trazable.
      </Alert>

      <div className="mt-6">
        {rows.length === 0 ? (
          <EmptyState
            icon={<Banknote size={22} className="text-ink-400" aria-hidden="true" />}
            title="Sin pagos registrados"
            description="Cuando se complete un trabajo aparecerá aquí su pago al trabajador."
          />
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => {
              const label = payoutStatusLabels[row.payout.status];
              return (
                <li key={row.payout.id}>
                  <Card>
                    <CardContent className="flex flex-wrap items-start justify-between gap-5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={label.tone}>{label.label}</Badge>
                          <span className="text-caption text-ink-500">{row.jobReference}</span>
                        </div>
                        <Link
                          href={`/mis-trabajos/${row.payout.assignmentId}`}
                          className="mt-1.5 block font-medium text-ink-950 hover:text-brand-700"
                        >
                          {row.jobTitle}
                        </Link>
                        <p className="mt-0.5 text-small text-ink-600">
                          {row.workerName}
                          {row.completedAt ? ` · completado ${formatDateTime(row.completedAt)}` : ""}
                        </p>
                        <p className="mt-1 text-small text-ink-500">
                          Bruto <Amount value={row.payout.grossAmount} /> · comisión{" "}
                          <Amount value={row.payout.commissionAmount} /> · neto{" "}
                          <strong className="text-ink-950">
                            <Amount value={row.payout.netAmount} />
                          </strong>
                        </p>
                        {row.payout.heldReason && (
                          <p className="mt-1 text-small text-warning-700">{row.payout.heldReason}</p>
                        )}
                        {row.payout.bankReference && (
                          <p className="mt-1 text-small text-success-700">
                            Referencia {row.payout.bankReference}
                          </p>
                        )}
                      </div>
                      <PayoutActions payoutId={row.payout.id} status={row.payout.status} />
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
