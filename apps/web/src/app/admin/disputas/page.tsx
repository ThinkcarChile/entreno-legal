import type { Metadata } from "next";
import Link from "next/link";

import { History, ShieldCheck } from "lucide-react";

import { DisputeResolutionForm } from "@/components/admin/dispute-resolution";
import { HistoryPager } from "@/components/admin/history-pager";
import { Amount, Badge, Card, CardContent, EmptyState } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { requireAdmin } from "@/lib/auth/session";
import { getData, type AdminDispute } from "@/lib/data";
import { isDisputeClosed } from "@/lib/data/admin-queues";
import { disputeEvidenceCountLabel } from "@/lib/domain/dispute-evidence";
import { DisputeStatus } from "@/lib/domain/enums";
import { disputeStatusLabels } from "@/lib/domain/labels";
import { formatDateTime } from "@/lib/utils/datetime";
import { HISTORY_PAGE_SIZE, pageWindow, parsePageParam } from "@/lib/utils/pagination";

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
 *
 * «Por atender» trae entero lo que pide una acción: las abiertas y las
 * resueltas a favor del cliente cuya devolución no está confirmada. Antes era
 * una sola lista con las cien más recientes, y una disputa abierta antigua
 * podía quedar fuera. El historial va por páginas.
 */
export default async function AdminDisputesPage({
  searchParams,
}: {
  searchParams: Promise<{ pagina?: string | string[] }>;
}) {
  await requireAdmin("/admin/disputas");
  const { pagina } = await searchParams;
  const page = parsePageParam(pagina);

  const admin = getData().admin;
  const [pending, history] = await Promise.all([
    admin.listActionableDisputes(),
    admin.listDisputeHistory(pageWindow(page, HISTORY_PAGE_SIZE)),
  ]);

  // Lo que no está cerrado es una disputa viva; lo resuelto que sigue aquí es
  // porque la devolución no está confirmada.
  const open = pending.filter((r) => !isDisputeClosed(r.dispute.status)).length;
  const refunds = pending.length - open;

  return (
    <div className="container-page py-8 sm:py-10">
      <header>
        <h1 className="text-h2 text-ink-950">Disputas</h1>
        <p className="mt-1 text-ink-600">
          {open} abierta{open === 1 ? "" : "s"} · {refunds} con devolución pendiente ·{" "}
          {history.total} cerrada{history.total === 1 ? "" : "s"}
        </p>
      </header>

      <Alert tone="warning" className="mt-5" title="Lo que una resolución hace y lo que no">
        Define la liberación de fondos dentro de la plataforma y deja anotado el monto a devolver
        al cliente. La devolución en sí se pide desde{" "}
        <Link href="/admin/pagos" className="font-medium underline underline-offset-2">
          los pagos de los clientes
        </Link>
        , y solo cuenta como hecha cuando el medio de pago la confirma.
      </Alert>

      <section className="mt-8" aria-labelledby="por-atender">
        <h2 id="por-atender" className="text-h3 text-ink-950">
          Por atender <span className="text-ink-500 tabular-nums">({pending.length})</span>
        </h2>
        <p className="mt-1 text-small text-ink-600">
          Todas, sin importar su antigüedad. Las más antiguas primero.
        </p>
        <div className="mt-4">
          {pending.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck size={22} className="text-ink-400" aria-hidden="true" />}
              title="Nada por atender"
              description="No hay reclamos abiertos ni devoluciones pendientes."
            />
          ) : (
            <ul className="space-y-3">
              {pending.map((row) => (
                <li key={row.dispute.id}>
                  <DisputeCard row={row} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section id="historial" className="mt-10 scroll-mt-6" aria-labelledby="historial-titulo">
        <h2 id="historial-titulo" className="text-h3 text-ink-950">
          Historial <span className="text-ink-500 tabular-nums">({history.total})</span>
        </h2>
        <p className="mt-1 text-small text-ink-600">
          Resueltas y retiradas, las más recientes primero.
        </p>
        <div className="mt-4">
          {history.items.length === 0 ? (
            <EmptyState
              icon={<History size={22} className="text-ink-400" aria-hidden="true" />}
              title={history.total > 0 ? "No hay más páginas" : "Sin disputas cerradas"}
              description={
                history.total > 0
                  ? "Esta página está más allá del final del historial."
                  : "Aquí quedan las disputas resueltas y las retiradas."
              }
            />
          ) : (
            <ul className="space-y-3">
              {history.items.map((row) => (
                <li key={row.dispute.id}>
                  <DisputeCard row={row} />
                </li>
              ))}
            </ul>
          )}
          <HistoryPager
            basePath="/admin/disputas"
            page={page}
            total={history.total}
            pageSize={HISTORY_PAGE_SIZE}
          />
        </div>
      </section>
    </div>
  );
}

function DisputeCard({ row }: { row: AdminDispute }) {
  const label = disputeStatusLabels[row.dispute.status];
  const refundAmount = row.dispute.refundAmount;

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={label.tone}>{label.label}</Badge>
              {row.refundPending && <Badge tone="warning">Devolución pendiente</Badge>}
              <span className="text-caption text-ink-500">{row.jobReference}</span>
            </div>
            <p className="mt-1.5 font-medium text-ink-950">{row.jobTitle}</p>
            <p className="mt-0.5 text-small text-ink-600">
              {row.clientName} (cliente) · {row.workerName} (trabajador) ·{" "}
              {formatDateTime(row.dispute.createdAt)}
            </p>
          </div>
          {row.amountHeld && (
            <p className="shrink-0 text-right">
              <span className="block text-caption text-ink-500">Monto en juego</span>
              <span className="text-h3 text-ink-950 tabular-nums">
                <Amount value={row.amountHeld} />
              </span>
            </p>
          )}
        </div>

        <div className="rounded-[var(--radius-control)] bg-ink-50 p-3.5 text-small">
          <p className="font-medium text-ink-950">{row.dispute.reason}</p>
          <p className="mt-1 text-ink-700">{row.dispute.description}</p>
        </div>

        {/* El caso entero —línea de tiempo, fotos, llegadas y las pruebas de
            las dos partes— vive en su propia pantalla de administración. */}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small">
          <span className="text-ink-600">{disputeEvidenceCountLabel(row.evidenceCount)}</span>
          <Link
            href={`/admin/trabajos/${row.dispute.assignmentId}`}
            className="font-medium text-brand-700 underline underline-offset-2"
          >
            Ver el trabajo y su evidencia
          </Link>
        </p>

        {row.dispute.status === DisputeStatus.RESOLVED ? (
          <div className="rounded-[var(--radius-control)] bg-success-50 p-3.5 text-small text-success-800">
            <p className="font-medium">Resuelta: {row.dispute.resolution}</p>
            <p className="mt-1">{row.dispute.resolutionNotes}</p>
            {refundAmount && refundAmount.amount > 0 && (
              <p className="mt-1">
                Monto a devolver al cliente: <Amount value={refundAmount} /> ·{" "}
                {row.refundPending ? (
                  <>
                    falta confirmar <Amount value={row.refundPending} />. Se pide desde{" "}
                    {/* Directo al pago, aunque sea antiguo: la lista de pagos no
                        tiene por qué tenerlo en su primera página. */}
                    <Link
                      href={
                        row.paymentId
                          ? `/admin/pagos?pago=${row.paymentId}`
                          : "/admin/pagos?filtro=review"
                      }
                      className="font-medium underline underline-offset-2"
                    >
                      {row.paymentId ? "el pago de este trabajo" : "los pagos en revisión"}
                    </Link>
                    .
                  </>
                ) : (
                  "devolución confirmada."
                )}
              </p>
            )}
          </div>
        ) : row.dispute.status === DisputeStatus.WITHDRAWN ? null : (
          <div className="flex flex-wrap items-start gap-3">
            <DisputeResolutionForm disputeId={row.dispute.id} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
