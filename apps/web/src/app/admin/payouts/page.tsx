import type { Metadata } from "next";
import Link from "next/link";

import { Banknote, History } from "lucide-react";

import { HistoryPager } from "@/components/admin/history-pager";
import { PayoutActions } from "@/components/admin/payout-actions";
import { Amount, Badge, Card, CardContent, EmptyState } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { requireAdmin } from "@/lib/auth/session";
import { getData, type AdminPayout } from "@/lib/data";
import { payoutStatusLabels } from "@/lib/domain/labels";
import { formatDateTime } from "@/lib/utils/datetime";
import { HISTORY_PAGE_SIZE, pageWindow, parsePageParam } from "@/lib/utils/pagination";

export const metadata: Metadata = {
  title: "Pagos a trabajadores",
  robots: { index: false, follow: false },
};

/**
 * Pagos a trabajadores.
 *
 * La transferencia es manual y se registra con su referencia bancaria. Nada de
 * lo que ocurre aquí mueve dinero: lo anota.
 *
 * Dos listas. Arriba, todo lo que todavía pide algo —aprobar, transferir,
 * revisar una retención—, entero y del más antiguo al más reciente: antes era
 * una sola lista con los cien más recientes de cualquier estado, y un payout
 * aprobado de hace semanas desaparecía de la única pantalla donde se
 * transfiere. Abajo, el historial de transferidos y cancelados, por páginas.
 */
export default async function AdminPayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string | string[] }>;
}) {
  await requireAdmin("/admin/payouts");
  const { pagina } = await searchParams;
  const page = parsePageParam(pagina);

  const admin = getData().admin;
  const [pending, history] = await Promise.all([
    admin.listActionablePayouts(),
    admin.listPayoutHistory(pageWindow(page, HISTORY_PAGE_SIZE)),
  ]);

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

      <section className="mt-8" aria-labelledby="por-resolver">
        <h2 id="por-resolver" className="text-h3 text-ink-950">
          Por resolver{" "}
          <span className="text-ink-500 tabular-nums">({pending.length})</span>
        </h2>
        <p className="mt-1 text-small text-ink-600">
          Todos, sin importar su antigüedad. Los más antiguos primero.
        </p>
        <div className="mt-4">
          {pending.length === 0 ? (
            <EmptyState
              icon={<Banknote size={22} className="text-ink-400" aria-hidden="true" />}
              title="Nada por resolver"
              description="Cuando se complete un trabajo aparecerá aquí su pago al trabajador."
            />
          ) : (
            <ul className="space-y-3">
              {pending.map((row) => (
                <li key={row.payout.id}>
                  <PayoutCard row={row} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section id="historial" className="mt-10 scroll-mt-6" aria-labelledby="historial-titulo">
        <h2 id="historial-titulo" className="text-h3 text-ink-950">
          Historial{" "}
          <span className="text-ink-500 tabular-nums">({history.total})</span>
        </h2>
        <p className="mt-1 text-small text-ink-600">Transferidos y cancelados, los más recientes primero.</p>
        <div className="mt-4">
          {history.items.length === 0 ? (
            <EmptyState
              icon={<History size={22} className="text-ink-400" aria-hidden="true" />}
              title={history.total > 0 ? "No hay más páginas" : "Sin pagos cerrados"}
              description={
                history.total > 0
                  ? "Esta página está más allá del final del historial."
                  : "Aquí quedan los pagos transferidos y los cancelados."
              }
            />
          ) : (
            <ul className="space-y-3">
              {history.items.map((row) => (
                <li key={row.payout.id}>
                  <PayoutCard row={row} />
                </li>
              ))}
            </ul>
          )}
          <HistoryPager
            basePath="/admin/payouts"
            page={page}
            total={history.total}
            pageSize={HISTORY_PAGE_SIZE}
          />
        </div>
      </section>
    </div>
  );
}

function PayoutCard({ row }: { row: AdminPayout }) {
  const label = payoutStatusLabels[row.payout.status];
  return (
    <Card>
      <CardContent className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={label.tone}>{label.label}</Badge>
            <span className="text-caption text-ink-500">{row.jobReference}</span>
          </div>
          <Link
            href={`/admin/trabajos/${row.payout.assignmentId}`}
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
          {row.payout.status === "APPROVED" && row.disputeWindowOpen && row.disputeDeadlineAt && (
            <p className="mt-1 text-small text-ink-600">
              Transferible desde {formatDateTime(row.disputeDeadlineAt)}: hasta entonces el cliente
              puede reportar un problema.
            </p>
          )}
          {row.payout.heldReason && (
            <p className="mt-1 text-small text-warning-700">{row.payout.heldReason}</p>
          )}
          {row.payout.bankReference && (
            <p className="mt-1 text-small text-success-700">Referencia {row.payout.bankReference}</p>
          )}
        </div>
        <PayoutActions payoutId={row.payout.id} status={row.payout.status} />
      </CardContent>
    </Card>
  );
}
