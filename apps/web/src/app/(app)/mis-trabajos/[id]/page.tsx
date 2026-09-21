import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { CalendarClock, ChevronLeft, Gift, MessageSquare, Target } from "lucide-react";

import { AssignmentActions } from "@/components/jobs/assignment-actions";
import { JobLocationBlock } from "@/components/jobs/job-location";
import { JobTimeline } from "@/components/jobs/job-timeline";
import { Amount, Avatar, Badge, ButtonLink, Card, CardContent } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { site } from "@/config/site";
import { requireOnboardedUser } from "@/lib/auth/session";
import { getData } from "@/lib/data";
import { AssignmentStatus, JobStatus, PaymentStatus } from "@/lib/domain/enums";
import { isCancellationPending, isPayable, workerFacingStage } from "@/lib/domain/job-actions";
import { assignmentStatusLabels } from "@/lib/domain/labels";
import { formatDate, formatDuration, formatTime } from "@/lib/utils/datetime";
import { formatPercent } from "@/lib/utils/format";

export const metadata: Metadata = {
  title: "Trabajo asignado",
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pago?: string }>;
}

/**
 * Pantalla central del trabajo asignado.
 *
 * Es la misma para cliente y trabajador; cambian las acciones disponibles, que
 * se derivan del estado y del rol, nunca de condiciones sueltas en el marcado.
 */
export default async function AssignmentPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { pago } = await searchParams;

  const session = await requireOnboardedUser(`/mis-trabajos/${id}`);
  const detail = await getData().jobs.getAssignment(id);

  if (!detail) notFound();

  const { assignment, job, client, worker, payment, settlement, timeline } = detail;
  const isClient = assignment.clientId === session.id;
  const isWorker = assignment.workerId === session.id;

  // RLS ya lo impediría, pero conviene una redirección entendible.
  if (!isClient && !isWorker) redirect("/mis-trabajos");

  const status = assignmentStatusLabels[assignment.status];
  const counterpart = isClient ? worker.profile : client;
  const paid = payment?.status === PaymentStatus.PAID;
  const cancellationPending = isCancellationPending(job.status);
  const cancelled =
    job.status === JobStatus.CANCELLED ||
    assignment.status === AssignmentStatus.CANCELLED_BY_CLIENT ||
    assignment.status === AssignmentStatus.CANCELLED_BY_WORKER;
  const paymentUnderReview = payment?.status === PaymentStatus.UNDER_REVIEW;
  // Solo se pide el pago mientras el trabajo de verdad lo espera: nunca con la
  // cancelación en verificación ni sobre un trabajo cancelado.
  const canPay = isClient && !paid && isPayable(job.status);

  return (
    <div className="container-page py-6 sm:py-10">
      <Link
        href={isClient ? "/mis-trabajos/publicados" : "/mis-trabajos"}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-600 hover:text-brand-700"
      >
        <ChevronLeft size={16} aria-hidden="true" />
        {isClient ? "Mis trabajos publicados" : "Mis trabajos"}
      </Link>

      {pago === "ok" && paid && (
        <Alert tone="success" className="mt-6" title="Pago confirmado">
          El dinero quedó asociado a este trabajo. El trabajador ya puede comenzar.
        </Alert>
      )}

      <div className="mt-6 grid gap-8 lg:grid-cols-[1.6fr_1fr] lg:gap-10">
        <div className="space-y-6">
          <header>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={status.tone}>{status.label}</Badge>
              <Badge tone="info">{job.category.name}</Badge>
              <span className="text-xs text-ink-400">{job.reference}</span>
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">
              {job.title}
            </h1>
            <p className="mt-1.5 text-sm text-ink-600">{workerFacingStage(assignment.status)}</p>
          </header>

          {cancellationPending && (
            <Alert tone="warning" title="Cancelación en verificación">
              {isClient
                ? "Estamos verificando el estado del pago antes de completar la cancelación. No hace falta que hagas nada."
                : "El cliente pidió cancelar este trabajo. Se completará en cuanto se verifique el pago. No inicies el trabajo."}
            </Alert>
          )}

          {cancelled && paymentUnderReview && (
            <Alert tone="warning" title="Trabajo cancelado · devolución pendiente">
              {isClient
                ? "El proveedor confirmó el cobro después de tu cancelación. El importe está registrado para devolución."
                : "Este trabajo quedó cancelado. El pago que llegó después no lo habilita y no genera un pago para ti."}
            </Alert>
          )}

          {cancelled && !paymentUnderReview && (
            <Alert tone="info" title="Trabajo cancelado">
              {isClient ? "Este trabajo quedó cancelado." : "El cliente canceló este trabajo."}
            </Alert>
          )}

          {!paid && !cancellationPending && !cancelled && (
            <Alert tone="warning" title="Falta confirmar el pago">
              {isClient ? (
                <>
                  El trabajo no puede comenzar sin pago confirmado.{" "}
                  <Link
                    href={`/pagar/${assignment.id}`}
                    className="font-medium underline underline-offset-2"
                  >
                    Ir al pago
                  </Link>
                </>
              ) : (
                "El cliente todavía no confirma el pago. Te avisamos apenas ocurra."
              )}
            </Alert>
          )}

          <Card>
            <CardContent className="space-y-6">
              <div className="flex items-center gap-3.5 border-b border-ink-100 pb-5">
                <Avatar src={counterpart.avatarUrl} name={counterpart.displayName} />
                <div className="min-w-0">
                  <p className="text-xs font-medium tracking-wide text-ink-500 uppercase">
                    {isClient ? "Trabajador" : "Cliente"}
                  </p>
                  <p className="font-medium text-ink-900">{counterpart.displayName}</p>
                </div>
                {detail.conversationId && (
                  <ButtonLink
                    href={`/mensajes/${detail.conversationId}`}
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                  >
                    <MessageSquare size={15} aria-hidden="true" />
                    Conversar
                  </ButtonLink>
                )}
              </div>

              <JobLocationBlock location={job.location} />

              <div className="flex gap-3.5">
                <CalendarClock size={18} className="mt-0.5 shrink-0 text-ink-400" aria-hidden="true" />
                <div>
                  <p className="text-xs font-medium tracking-wide text-ink-500 uppercase">Cuándo</p>
                  <p className="mt-1 text-[0.9375rem] text-ink-700 first-letter:uppercase">
                    {formatDate(job.startsAt, job.timezone)}
                  </p>
                  <p className="text-[0.9375rem] text-ink-500">
                    Desde las {formatTime(job.startsAt, job.timezone)} ·{" "}
                    {formatDuration(assignment.agreedDurationMinutes)}
                  </p>
                </div>
              </div>

              <div className="flex gap-3.5">
                <Target size={18} className="mt-0.5 shrink-0 text-ink-400" aria-hidden="true" />
                <div>
                  <p className="text-xs font-medium tracking-wide text-ink-500 uppercase">
                    Objetivo
                  </p>
                  <p className="mt-1 text-[0.9375rem] text-ink-700">
                    {job.objective.description ?? "Mantener el lugar en la fila."}
                  </p>
                </div>
              </div>

              {assignment.bonus && (
                <div className="flex gap-3 rounded-[var(--radius-control)] bg-success-50 p-4">
                  <Gift size={18} className="mt-0.5 shrink-0 text-success-600" aria-hidden="true" />
                  <div className="text-sm">
                    <p className="font-medium text-success-800">
                      Bono por objetivo: <Amount value={assignment.bonus} />
                    </p>
                    {job.objective.bonusConditions && (
                      <p className="mt-1 text-success-700">{job.objective.bonusConditions}</p>
                    )}
                  </div>
                </div>
              )}

              {job.instructions && (
                <div>
                  <p className="text-xs font-medium tracking-wide text-ink-500 uppercase">
                    Instrucciones
                  </p>
                  <p className="mt-1.5 text-[0.9375rem] whitespace-pre-line text-ink-700">
                    {job.instructions}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <h2 className="text-base font-semibold text-ink-900">Avance del trabajo</h2>
              <div className="mt-5">
                <JobTimeline entries={timeline} timezone={job.timezone} />
              </div>
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <Card>
            <CardContent>
              <p className="text-sm text-ink-500">
                {isClient ? "Total pagado" : "Recibes por este trabajo"}
              </p>
              <p className="mt-1 text-3xl font-semibold tracking-tight text-ink-900">
                <Amount value={isClient ? settlement.clientTotal : settlement.workerReceives} />
              </p>

              <dl className="mt-4 space-y-2 border-t border-ink-100 pt-4 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-600">Valor del trabajo</dt>
                  <dd className="text-ink-900 tabular-nums">
                    <Amount value={settlement.serviceAmount} />
                  </dd>
                </div>
                {settlement.bonusAmount.amount > 0 && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-600">Bono potencial</dt>
                    <dd className="text-ink-900 tabular-nums">
                      <Amount value={settlement.bonusAmount} />
                    </dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-600">
                    Tarifa {site.shortName} ({formatPercent(settlement.commissionBps / 10000, 0)})
                  </dt>
                  <dd className="text-ink-900 tabular-nums">
                    <Amount value={settlement.commissionAmount} />
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {isWorker && !cancellationPending && !cancelled && (
            <Card>
              <CardContent>
                <AssignmentActions assignmentId={assignment.id} status={assignment.status} />
              </CardContent>
            </Card>
          )}

          {canPay && (
            <ButtonLink href={`/pagar/${assignment.id}`} size="lg" fullWidth>
              Confirmar el pago
            </ButtonLink>
          )}
        </aside>
      </div>
    </div>
  );
}
