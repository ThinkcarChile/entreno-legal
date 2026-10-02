import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CalendarClock, ChevronLeft, MapPinned, Paperclip, Target } from "lucide-react";

import { DisputeEvidence } from "@/components/disputes/dispute-evidence";
import { EvidenceGallery } from "@/components/jobs/execution/evidence-gallery";
import { JobLocationBlock } from "@/components/jobs/job-location";
import { JobTimeline } from "@/components/jobs/job-timeline";
import { Amount, Badge, Card, CardContent } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { requireAdmin } from "@/lib/auth/session";
import { getData } from "@/lib/data";
import { CheckInResult, CheckInReview, DisputeStatus } from "@/lib/domain/enums";
import {
  assignmentStatusLabels,
  disputeStatusLabels,
  extensionStatusLabels,
  jobStatusLabels,
  paymentStatusLabels,
  payoutStatusLabels,
} from "@/lib/domain/labels";
import { isDisputeOpen } from "@/lib/domain/permissions";
import { formatDate, formatDateTime, formatDuration, formatTime } from "@/lib/utils/datetime";
import { objectiveSummary } from "@/lib/domain/objective";
import { settlementHeadline } from "@/lib/domain/settlement-view";

export const metadata: Metadata = {
  title: "Caso del trabajo",
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CHECK_IN_RESULT: Record<string, string> = {
  [CheckInResult.VERIFIED]: "Verificada",
  [CheckInResult.OUT_OF_RANGE]: "Fuera de rango",
  [CheckInResult.LOW_ACCURACY]: "Poca precisión",
  [CheckInResult.NO_LOCATION]: "Sin ubicación",
};

const CHECK_IN_REVIEW: Record<string, string> = {
  [CheckInReview.NOT_REQUIRED]: "sin revisión",
  [CheckInReview.PENDING]: "por revisar",
  [CheckInReview.APPROVED]: "aprobada",
  [CheckInReview.REJECTED]: "rechazada",
};

/**
 * El caso completo de un trabajo asignado, visto por la administración.
 *
 * Antes, todos los enlaces del panel a un trabajo llevaban a `/mis-trabajos`,
 * que es de las partes y devuelve a cualquier otro a su propia lista: las
 * disputas y las llegadas se decidían sin ver la línea de tiempo, las fotos ni
 * las pruebas de la disputa.
 *
 * Es de solo lectura. Lo único que se puede hacer aquí es aportar una prueba a
 * una disputa abierta, igual que las partes; resolverla sigue siendo cosa de
 * /admin/disputas. Todo se lee con la sesión del administrador y bajo RLS, con
 * el mismo acceso a datos que la pantalla de las partes.
 */
export default async function AdminAssignmentPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const { assignmentId } = await params;
  await requireAdmin(`/admin/trabajos/${assignmentId}`);
  if (!UUID.test(assignmentId)) notFound();

  const detail = await getData().jobs.getAssignment(assignmentId);
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
  } = detail;
  const headline = settlementHeadline({ settlement, payment, extensionPayments, payout });

  const status = assignmentStatusLabels[assignment.status];
  const jobStatus = jobStatusLabels[job.status];
  const disputeOpen = dispute ? isDisputeOpen(dispute.status) : false;

  return (
    <div className="container-page py-8 sm:py-10">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-small font-medium text-ink-600 hover:text-brand-700"
      >
        <ChevronLeft size={16} aria-hidden="true" />
        Panel
      </Link>

      <header className="mt-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          <Badge tone={jobStatus.tone}>Trabajo: {jobStatus.label}</Badge>
          <Badge tone="info">{job.category.name}</Badge>
          <span className="text-caption text-ink-500">{job.reference}</span>
        </div>
        <h1 className="mt-3 text-h2 text-ink-950">{job.title}</h1>
        <p className="mt-1 text-small text-ink-600">
          {client.displayName} (cliente) · {worker.profile.displayName} (trabajador) · solo
          lectura
        </p>
      </header>

      {disputeOpen && dispute && (
        <Alert tone="danger" className="mt-6" title="Disputa abierta">
          El pago al trabajador está retenido. Revisa la línea de tiempo, las fotos y las pruebas
          de las dos partes, y resuelve desde{" "}
          <Link href="/admin/disputas" className="font-medium underline underline-offset-2">
            Disputas
          </Link>
          .
        </Alert>
      )}

      <div className="mt-6 grid gap-8 lg:grid-cols-[1.6fr_1fr] lg:gap-10">
        <div className="space-y-6">
          {/* ------------------------------------------------ disputa */}
          {dispute && (
            <Card>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-ink-950">Disputa</h2>
                  <Badge tone={disputeStatusLabels[dispute.status].tone}>
                    {disputeStatusLabels[dispute.status].label}
                  </Badge>
                  <span className="text-caption text-ink-500">
                    abierta {formatDateTime(dispute.createdAt, job.timezone)}
                  </span>
                </div>
                <div className="rounded-[var(--radius-control)] bg-ink-50 p-3.5 text-small">
                  <p className="font-medium text-ink-950">{dispute.reason}</p>
                  <p className="mt-1 whitespace-pre-line text-ink-700">{dispute.description}</p>
                </div>
                {dispute.status === DisputeStatus.RESOLVED && (
                  <p className="text-small text-ink-700">
                    Resuelta: {dispute.resolution}. {dispute.resolutionNotes}
                    {dispute.refundAmount && dispute.refundAmount.amount > 0 && (
                      <>
                        {" "}
                        Monto a devolver al cliente: <Amount value={dispute.refundAmount} />.
                      </>
                    )}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {dispute && (
            <DisputeEvidence
              assignmentId={assignment.id}
              dispute={dispute}
              canAdd={disputeOpen}
              timezone={job.timezone}
            />
          )}

          {/* ------------------------------------------------ llegadas */}
          <Card>
            <CardContent>
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink-950">
                <MapPinned size={17} className="text-ink-400" aria-hidden="true" />
                Llegadas
              </h2>
              {checkIns.length === 0 ? (
                <p className="mt-3 text-small text-ink-500">El trabajador no registró llegadas.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {checkIns.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-[var(--radius-control)] border border-line p-3 text-small"
                    >
                      <p className="font-medium text-ink-950">
                        {CHECK_IN_RESULT[c.result] ?? c.result} ·{" "}
                        {CHECK_IN_REVIEW[c.reviewStatus] ?? c.reviewStatus}
                      </p>
                      <p className="mt-0.5 text-ink-600">
                        {formatDateTime(c.occurredAt, job.timezone)} ·{" "}
                        {c.distanceM != null ? `a ${c.distanceM} m del lugar` : "sin distancia"} ·{" "}
                        {c.source === "device" ? "ubicación del teléfono" : "registro manual"}
                      </p>
                      {c.reviewReason && <p className="mt-0.5 text-ink-500">{c.reviewReason}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* ------------------------------------------------ línea de tiempo */}
          <Card>
            <CardContent>
              <h2 className="text-base font-semibold text-ink-950">Avance del trabajo</h2>
              <div className="mt-5">
                <JobTimeline entries={timeline} timezone={job.timezone} />
              </div>
            </CardContent>
          </Card>

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

          {/* ------------------------------------------------ el encargo */}
          <Card>
            <CardContent className="space-y-6">
              <JobLocationBlock location={job.location} />

              <div className="flex gap-3.5">
                <CalendarClock size={18} className="mt-0.5 shrink-0 text-ink-400" aria-hidden="true" />
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
                    {objectiveSummary(job.objective)}
                  </p>
                  {job.objective.bonusConditions && (
                    <p className="mt-1 text-small text-ink-500">
                      Bono: {job.objective.bonusConditions}
                    </p>
                  )}
                </div>
              </div>

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

              {assignment.completionNote && (
                <div>
                  <p className="text-caption font-medium tracking-wide text-ink-500 uppercase">
                    Nota de cierre del trabajador
                  </p>
                  <p className="mt-1.5 text-[0.9375rem] whitespace-pre-line text-ink-700">
                    {assignment.completionNote}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ------------------------------------------------------- columna lateral */}
        <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <Card>
            <CardContent className="space-y-4 text-small">
              <div>
                <p className="text-ink-500">Cobrado al cliente</p>
                <p className="mt-1 text-h2 text-ink-950">
                  <Amount value={headline.clientCharged} />
                </p>
                {headline.extensionCharged.amount > 0 && (
                  <p className="text-ink-500">
                    Incluye <Amount value={headline.extensionCharged} /> de tiempo adicional
                  </p>
                )}
                <p className="text-ink-500">
                  {headline.fromPayout ? "El trabajador recibe" : "Acordado para el trabajador"}{" "}
                  <Amount value={headline.workerReceives} />
                </p>
              </div>

              <div className="border-t border-ink-100 pt-4">
                <p className="text-ink-500">Pago del trabajo</p>
                {payment ? (
                  <p className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge tone={paymentStatusLabels[payment.status].tone}>
                      {paymentStatusLabels[payment.status].label}
                    </Badge>
                    <Link
                      href={`/admin/pagos?pago=${payment.id}`}
                      className="font-medium text-brand-700 underline underline-offset-2"
                    >
                      Ver el pago
                    </Link>
                  </p>
                ) : (
                  <p className="mt-1 text-ink-600">Sin pago iniciado.</p>
                )}
              </div>

              <div className="border-t border-ink-100 pt-4">
                <p className="text-ink-500">Pago al trabajador</p>
                {payout ? (
                  <>
                    <p className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge tone={payoutStatusLabels[payout.status].tone}>
                        {payoutStatusLabels[payout.status].label}
                      </Badge>
                      <Amount value={payout.netAmount} />
                    </p>
                    {payout.heldReason && <p className="mt-1 text-ink-600">{payout.heldReason}</p>}
                  </>
                ) : (
                  <p className="mt-1 text-ink-600">Todavía no existe.</p>
                )}
                {assignment.disputeDeadlineAt && (
                  <p className="mt-1 text-ink-500">
                    Plazo para reportar problemas:{" "}
                    {formatDateTime(assignment.disputeDeadlineAt, job.timezone)}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {extensions.length > 0 && (
            <Card>
              <CardContent>
                <h2 className="text-base font-semibold text-ink-950">Tiempo adicional</h2>
                <ul className="mt-3 space-y-2 text-small">
                  {extensions.map((e) => {
                    const extensionPayment = extensionPayments[e.id];
                    return (
                      <li key={e.id} className="flex flex-wrap items-center gap-2">
                        <Badge tone={extensionStatusLabels[e.status].tone}>
                          {extensionStatusLabels[e.status].label}
                        </Badge>
                        <span className="text-ink-700">
                          {formatDuration(e.additionalMinutes)} ·{" "}
                          <Amount value={e.additionalAmount} />
                        </span>
                        {extensionPayment && (
                          <Link
                            href={`/admin/pagos?pago=${extensionPayment.id}`}
                            className="text-brand-700 underline underline-offset-2"
                          >
                            {paymentStatusLabels[extensionPayment.status].label}
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
