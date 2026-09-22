import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  CalendarClock,
  ChevronLeft,
  Gift,
  MessageSquare,
  Paperclip,
  Target,
} from "lucide-react";

import { EvidenceForm } from "@/components/jobs/execution/evidence-form";
import { EvidenceGallery } from "@/components/jobs/execution/evidence-gallery";
import {
  ExtensionAnswer,
  ExtensionPaymentPrompt,
  ExtensionRequestForm,
} from "@/components/jobs/execution/extension-panel";
import {
  ApprovalPanel,
  DisputeForm,
} from "@/components/jobs/execution/completion-panel";
import {
  ClientHandoffPanel,
  WorkerHandoffPanel,
} from "@/components/jobs/execution/handoff-panel";
import { ReviewForm } from "@/components/jobs/execution/review-form";
import { WorkerSteps } from "@/components/jobs/execution/worker-steps";
import { WorkTimer } from "@/components/jobs/execution/work-timer";
import { JobLocationBlock } from "@/components/jobs/job-location";
import { JobTimeline } from "@/components/jobs/job-timeline";
import { Amount, Avatar, Badge, ButtonLink, Card, CardContent } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { site } from "@/config/site";
import { requireOnboardedUser } from "@/lib/auth/session";
import { getData } from "@/lib/data";
import {
  AssignmentStatus,
  CheckInReview,
  DisputeStatus,
  ExtensionStatus,
  JobStatus,
  PaymentStatus,
  PayoutStatus,
} from "@/lib/domain/enums";
import { isCancellationPending } from "@/lib/domain/job-actions";
import { assignmentStatusLabels, payoutStatusLabels } from "@/lib/domain/labels";
import {
  assignmentAbilities,
  checkInNeedsReview,
  checkInUnlocks,
  isDisputeOpen,
  isExtensionPending,
  nextWorkerStep,
  waitingFor,
  type AssignmentFacts,
} from "@/lib/domain/permissions";
import { formatDate, formatDuration, formatTime, hasPassed } from "@/lib/utils/datetime";
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
 * Centro operativo del trabajo asignado.
 *
 * Es la misma página para cliente y trabajador. Lo que cambia no lo deciden
 * condiciones sueltas en el marcado, sino `assignmentAbilities`: una sola
 * función que mira rol, estados, disputa y extensiones y dice qué se puede
 * hacer. La base vuelve a comprobarlo todo, así que un botón de más no abre
 * nada; un botón de menos, en cambio, deja a alguien sin poder trabajar.
 */
export default async function AssignmentPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { pago } = await searchParams;

  const session = await requireOnboardedUser(`/mis-trabajos/${id}`);
  const detail = await getData().jobs.getAssignment(id);

  if (!detail) notFound();

  const {
    assignment,
    job,
    client,
    worker,
    payment,
    settlement,
    timeline,
    checkIns,
    extensions,
    extensionPayments,
    dispute,
    payout,
    reviewAuthors,
  } = detail;

  const isClient = assignment.clientId === session.id;
  const isWorker = assignment.workerId === session.id;
  if (!isClient && !isWorker) redirect("/mis-trabajos");

  const pendingExtension = extensions.find((e) => isExtensionPending(e.status, e.expiresAt));
  const acceptedUnpaid = extensions.find(
    (e) =>
      e.status === ExtensionStatus.ACCEPTED &&
      extensionPayments[e.id]?.status !== PaymentStatus.PAID,
  );

  const facts: AssignmentFacts = {
    party: isClient ? "client" : "worker",
    jobStatus: job.status,
    assignmentStatus: assignment.status,
    paymentStatus: payment?.status ?? null,
    hasOpenDispute: dispute ? isDisputeOpen(dispute.status) : false,
    pendingExtension: Boolean(pendingExtension),
    hasValidCheckIn: checkIns.some((c) => checkInUnlocks(c.result, c.reviewStatus)),
    hasCheckInUnderReview: checkIns.some((c) => checkInNeedsReview(c.reviewStatus)),
    payoutStatus: payout?.status ?? null,
    disputeWindowClosed: hasPassed(assignment.disputeDeadlineAt),
    hasReviewed: reviewAuthors.includes(session.id),
  };

  const can = assignmentAbilities(facts);
  const step = nextWorkerStep(facts, can);
  const status = assignmentStatusLabels[assignment.status];
  const counterpart = isClient ? worker.profile : client;
  const cancellationPending = isCancellationPending(job.status);
  const cancelled =
    job.status === JobStatus.CANCELLED ||
    assignment.status === AssignmentStatus.CANCELLED_BY_CLIENT ||
    assignment.status === AssignmentStatus.CANCELLED_BY_WORKER;
  const paid = payment?.status === PaymentStatus.PAID;
  const paymentUnderReview = payment?.status === PaymentStatus.UNDER_REVIEW;

  const lastCheckIn = checkIns[0] ?? null;
  const checkInReason =
    lastCheckIn && lastCheckIn.reviewStatus === CheckInReview.PENDING
      ? lastCheckIn.reviewReason
      : null;

  return (
    <div className="container-page py-6 sm:py-10">
      <Link
        href={isClient ? "/mis-trabajos/publicados" : "/mis-trabajos"}
        className="inline-flex items-center gap-1.5 text-small font-medium text-ink-600 hover:text-brand-700"
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
              <span className="text-caption text-ink-500">{job.reference}</span>
            </div>
            <h1 className="mt-3 text-h2 text-ink-950 sm:text-h1">
              {job.title}
            </h1>
            <p className="mt-1.5 text-small text-ink-600">{waitingFor(facts)}</p>
          </header>

          {/* ------------------------------------------------ avisos de estado */}

          {facts.hasOpenDispute && dispute && (
            <Alert tone="danger" title="Hay una disputa abierta">
              {dispute.reason}. El pago al trabajador está retenido mientras la administración
              revisa el caso.
            </Alert>
          )}

          {dispute?.status === DisputeStatus.RESOLVED && (
            <Alert tone="info" title="La disputa se resolvió">
              {dispute.resolutionNotes}
              {dispute.refundAmount && dispute.refundAmount.amount > 0 && (
                <>
                  {" "}
                  Se registró una devolución de <Amount value={dispute.refundAmount} /> a favor del
                  cliente. Queda anotada para procesarse; no es una devolución bancaria hecha.
                </>
              )}
            </Alert>
          )}

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

          {/* --------------------------------------------- tiempo del trabajo */}

          {assignment.startedAt && (
            <WorkTimer
              startedAt={assignment.startedAt}
              expectedEndAt={assignment.expectedEndAt}
              completedAt={assignment.completedAt}
            />
          )}

          {/* ------------------------------------------------ contraparte */}

          <Card>
            <CardContent className="space-y-6">
              <div className="flex items-center gap-3.5 border-b border-ink-100 pb-5">
                <Avatar src={counterpart.avatarUrl} name={counterpart.displayName} />
                <div className="min-w-0">
                  <p className="text-caption font-medium tracking-wide text-ink-500 uppercase">
                    {isClient ? "Trabajador" : "Cliente"}
                  </p>
                  <p className="font-medium text-ink-950">{counterpart.displayName}</p>
                </div>
                {detail.conversationId && can.canChat && (
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
                <CalendarClock
                  size={18}
                  className="mt-0.5 shrink-0 text-ink-400"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-caption font-medium tracking-wide text-ink-500 uppercase">Cuándo</p>
                  <p className="mt-1 text-[0.9375rem] text-ink-700 first-letter:uppercase">
                    {formatDate(job.startsAt, job.timezone)}
                  </p>
                  <p className="text-[0.9375rem] text-ink-500">
                    Desde las {formatTime(job.startsAt, job.timezone)} ·{" "}
                    {formatDuration(assignment.agreedDurationMinutes)}
                    {assignment.extensionMinutes > 0 && (
                      <> + {formatDuration(assignment.extensionMinutes)} de extensión</>
                    )}
                  </p>
                </div>
              </div>

              <div className="flex gap-3.5">
                <Target size={18} className="mt-0.5 shrink-0 text-ink-400" aria-hidden="true" />
                <div>
                  <p className="text-caption font-medium tracking-wide text-ink-500 uppercase">
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
                  <div className="text-small">
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
                  <p className="text-caption font-medium tracking-wide text-ink-500 uppercase">
                    Instrucciones
                  </p>
                  <p className="mt-1.5 text-[0.9375rem] whitespace-pre-line text-ink-700">
                    {job.instructions}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ------------------------------------------------ actualizaciones */}

          {can.canAddEvidence && (
            <Card>
              <CardContent>
                <h2 className="text-base font-semibold text-ink-950">
                  {isWorker ? "Informar al cliente" : "Aportar una nota o foto"}
                </h2>
                <p className="mt-1 mb-4 text-small text-ink-500">
                  Todo lo que envíes queda en la línea de tiempo del trabajo y sirve como evidencia.
                </p>
                <EvidenceForm assignmentId={assignment.id} />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent>
              <h2 className="text-base font-semibold text-ink-950">Avance del trabajo</h2>
              <div className="mt-5">
                <JobTimeline entries={timeline} timezone={job.timezone} />
              </div>
            </CardContent>
          </Card>

          {timeline.some((entry) => entry.storagePath) && (
            <Card>
              <CardContent>
                <h2 className="flex items-center gap-2 text-base font-semibold text-ink-950">
                  <Paperclip size={17} className="text-ink-400" aria-hidden="true" />
                  Evidencia adjunta
                </h2>
                <div className="mt-4">
                  <EvidenceGallery entries={timeline} timezone={job.timezone} />
                </div>
              </CardContent>
            </Card>
          )}

          {can.canReview && (
            <Card>
              <CardContent>
                <h2 className="text-base font-semibold text-ink-950">¿Cómo fue tu experiencia?</h2>
                <div className="mt-4">
                  <ReviewForm
                    assignmentId={assignment.id}
                    counterpartName={counterpart.displayName}
                  />
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* ------------------------------------------------------- columna lateral */}

        <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <Card>
            <CardContent>
              <p className="text-small text-ink-500">
                {isClient ? "Total pagado" : "Recibes por este trabajo"}
              </p>
              <p className="mt-1 text-h1 text-ink-950">
                <Amount value={isClient ? settlement.clientTotal : settlement.workerReceives} />
              </p>

              <dl className="mt-4 space-y-2 border-t border-ink-100 pt-4 text-small">
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-600">Valor del trabajo</dt>
                  <dd className="text-ink-950 tabular-nums">
                    <Amount value={settlement.serviceAmount} />
                  </dd>
                </div>
                {settlement.bonusAmount.amount > 0 && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-600">
                      {assignment.bonusAwarded === false ? "Bono no otorgado" : "Bono potencial"}
                    </dt>
                    <dd className="text-ink-950 tabular-nums">
                      <Amount value={settlement.bonusAmount} />
                    </dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-600">
                    Tarifa {site.shortName} ({formatPercent(settlement.commissionBps / 10000, 0)})
                  </dt>
                  <dd className="text-ink-950 tabular-nums">
                    <Amount value={settlement.commissionAmount} />
                  </dd>
                </div>
              </dl>

              {isWorker && payout && (
                <p className="mt-4 border-t border-ink-100 pt-4 text-small">
                  <span className="text-ink-600">Estado de tu pago: </span>
                  <Badge tone={payoutStatusLabels[payout.status].tone}>
                    {payoutStatusLabels[payout.status].label}
                  </Badge>
                  {payout.status === PayoutStatus.PAID && payout.bankReference && (
                    <span className="mt-1 block text-caption text-ink-500">
                      Referencia {payout.bankReference}
                    </span>
                  )}
                </p>
              )}
            </CardContent>
          </Card>

          {/* --- El paso del trabajador --- */}
          {isWorker && step && (
            <Card>
              <CardContent>
                <WorkerSteps
                  assignmentId={assignment.id}
                  step={step}
                  lastCheckInReason={checkInReason}
                />
              </CardContent>
            </Card>
          )}

          {/* --- Código de entrega --- */}
          {(can.canVerifyHandoffCode || (isClient && can.canGenerateHandoffCode)) && (
            <Card>
              <CardContent>
                <h2 className="mb-3 text-base font-semibold text-ink-950">Código de entrega</h2>
                {isWorker ? (
                  <WorkerHandoffPanel assignmentId={assignment.id} />
                ) : (
                  <ClientHandoffPanel
                    assignmentId={assignment.id}
                    canGenerate={can.canGenerateHandoffCode}
                  />
                )}
              </CardContent>
            </Card>
          )}

          {/* --- Tiempo adicional --- */}
          {(can.canRequestExtension || (can.canAnswerExtension && pendingExtension)) && (
            <Card>
              <CardContent className="space-y-3">
                <h2 className="text-base font-semibold text-ink-950">Tiempo adicional</h2>
                {can.canAnswerExtension && pendingExtension ? (
                  <ExtensionAnswer assignmentId={assignment.id} extension={pendingExtension} />
                ) : (
                  <ExtensionRequestForm assignmentId={assignment.id} />
                )}
              </CardContent>
            </Card>
          )}

          {isClient && acceptedUnpaid && (
            <ExtensionPaymentPrompt
              extension={acceptedUnpaid}
              payment={extensionPayments[acceptedUnpaid.id] ?? null}
            />
          )}

          {isWorker && pendingExtension && (
            <Alert tone="info" title="Solicitud enviada">
              El cliente tiene que responder a tu solicitud de{" "}
              {formatDuration(pendingExtension.additionalMinutes)} más.
            </Alert>
          )}

          {/* --- Aprobación del cliente --- */}
          {can.canApproveCompletion && (
            <Card>
              <CardContent className="space-y-3">
                <h2 className="text-base font-semibold text-ink-950">Cerrar el trabajo</h2>
                <p className="text-small text-ink-600">
                  {assignment.completionRequestedAt
                    ? "El trabajador dio por terminado el trabajo. Revisa el avance y la evidencia antes de aprobar."
                    : "Puedes aprobar cuando el trabajo esté hecho a tu conformidad."}
                </p>
                {assignment.completionNote && (
                  <p className="rounded-[var(--radius-control)] bg-ink-50 p-3 text-small text-ink-700">
                    {assignment.completionNote}
                  </p>
                )}
                <ApprovalPanel
                  assignmentId={assignment.id}
                  bonus={assignment.bonus}
                  bonusConditions={job.objective.bonusConditions}
                  workerReceives={settlement.workerReceives}
                />
              </CardContent>
            </Card>
          )}

          {/* --- Reportar un problema --- */}
          {can.canOpenDispute && (
            <Card>
              <CardContent>
                <DisputeForm assignmentId={assignment.id} />
              </CardContent>
            </Card>
          )}

          {can.canPay && (
            <ButtonLink href={`/pagar/${assignment.id}`} size="lg" fullWidth>
              Confirmar el pago
            </ButtonLink>
          )}

          <p className="text-center text-caption text-ink-500">
            ¿Necesitas ayuda?{" "}
            <Link href="/contacto" className="font-medium underline underline-offset-2">
              Escríbenos
            </Link>
          </p>
        </aside>
      </div>
    </div>
  );
}
