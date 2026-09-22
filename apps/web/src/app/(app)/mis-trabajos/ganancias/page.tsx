import type { Metadata } from "next";
import Link from "next/link";

import { ChevronLeft, Wallet } from "lucide-react";

import { Amount, Badge, Card, CardContent, EmptyState, Stat } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { requireWorker } from "@/lib/auth/session";
import { getData } from "@/lib/data";
import { payoutStatusLabels } from "@/lib/domain/labels";
import { formatDate } from "@/lib/utils/datetime";

export const metadata: Metadata = {
  title: "Mis ganancias",
  robots: { index: false, follow: false },
};

/**
 * Mis ganancias.
 *
 * Cada cifra dice exactamente en qué estado está y por qué. Lo que importa aquí
 * es lo que NO se afirma: «pagado» solo aparece cuando hay una transferencia
 * registrada con su referencia bancaria. La plataforma no mueve dinero todavía,
 * y una pantalla que insinuara lo contrario sería el peor lugar para hacerlo.
 */
export default async function EarningsPage() {
  await requireWorker("/mis-trabajos/ganancias");
  const data = getData();
  const [rows, summary] = await Promise.all([
    data.earnings.listMine(),
    data.earnings.summary(),
  ]);

  return (
    <div className="container-page py-6 sm:py-10">
      <Link
        href="/mis-trabajos"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-600 hover:text-brand-700"
      >
        <ChevronLeft size={16} aria-hidden="true" />
        Mis trabajos
      </Link>

      <header className="mt-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">
          Mis ganancias
        </h1>
        <p className="mt-1.5 text-sm text-ink-600">
          Lo que has ganado por trabajo, con el estado real de cada pago.
        </p>
      </header>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Aprobado"
          value={<Amount value={summary.approved} />}
          hint="Listo para transferir"
        />
        <Stat
          label="Pendiente"
          value={<Amount value={summary.pending} />}
          hint="Falta que el cliente apruebe"
        />
        <Stat label="Retenido" value={<Amount value={summary.held} />} hint="Hay una disputa" />
        <Stat
          label="Transferido"
          value={<Amount value={summary.paid} />}
          hint="Con referencia bancaria"
        />
      </div>

      <Alert tone="info" className="mt-5" title="Cómo funciona el pago hoy">
        La transferencia la registra una persona del equipo con su referencia bancaria. Un pago
        aparece como transferido solo cuando eso ocurrió de verdad.
      </Alert>

      <div className="mt-6">
        {rows.length === 0 ? (
          <EmptyState
            icon={<Wallet size={22} className="text-ink-400" aria-hidden="true" />}
            title="Todavía no tienes ganancias"
            description="Cuando completes tu primer trabajo aparecerá aquí, con su desglose."
          />
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => {
              const label = payoutStatusLabels[row.status];
              return (
                <li key={row.id}>
                  <Card>
                    <CardContent className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={label.tone}>{label.label}</Badge>
                          <span className="text-xs text-ink-400">{row.jobReference}</span>
                        </div>
                        <Link
                          href={`/mis-trabajos/${row.assignmentId}`}
                          className="mt-1.5 block font-medium text-ink-900 hover:text-brand-700"
                        >
                          {row.jobTitle}
                        </Link>
                        <p className="mt-0.5 text-sm text-ink-500">
                          {formatDate(row.jobStartsAt)}
                        </p>
                        {row.heldReason && (
                          <p className="mt-1 text-sm text-warning-700">{row.heldReason}</p>
                        )}
                        {row.bankReference && (
                          <p className="mt-1 text-sm text-success-700">
                            Transferido · referencia {row.bankReference}
                          </p>
                        )}
                      </div>

                      <dl className="shrink-0 space-y-1 text-right text-sm">
                        <div>
                          <dt className="sr-only">Monto del trabajo</dt>
                          <dd className="text-ink-600 tabular-nums">
                            <Amount value={row.grossAmount} />
                          </dd>
                        </div>
                        {row.bonusAmount.amount > 0 && (
                          <div>
                            <dt className="sr-only">Bono</dt>
                            <dd className="text-success-700 tabular-nums">
                              + <Amount value={row.bonusAmount} /> de bono
                            </dd>
                          </div>
                        )}
                        <div>
                          <dt className="sr-only">Comisión</dt>
                          <dd className="text-ink-500 tabular-nums">
                            − <Amount value={row.commissionAmount} /> de comisión
                          </dd>
                        </div>
                        <div className="border-t border-ink-100 pt-1">
                          <dt className="sr-only">Recibes</dt>
                          <dd className="text-base font-semibold text-ink-900 tabular-nums">
                            <Amount value={row.netAmount} />
                          </dd>
                        </div>
                      </dl>
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
