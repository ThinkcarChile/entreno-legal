import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { CalendarClock, ChevronLeft, Gift, Target, Users } from "lucide-react";

import { CancelJobButton } from "@/components/jobs/cancel-job-button";
import { JobLocationBlock } from "@/components/jobs/job-location";
import { JobTimeline } from "@/components/jobs/job-timeline";
import { OfferCard } from "@/components/jobs/offer-card";
import { Amount, Badge, ButtonLink, Card, CardContent, HourlyRate } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { requireOnboardedUser } from "@/lib/auth/session";
import { getData } from "@/lib/data";
import { jobPermissions } from "@/lib/domain/job-actions";
import { jobStatusLabels } from "@/lib/domain/labels";
import { formatDate, formatDuration, formatTime } from "@/lib/utils/datetime";

export const metadata: Metadata = {
  title: "Mi trabajo",
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Panel del cliente sobre su propio trabajo: ofertas recibidas, avance y
 * acciones disponibles según el estado.
 */
export default async function ClientJobDetailPage({ params }: PageProps) {
  const { id } = await params;
  const session = await requireOnboardedUser(`/mis-trabajos/publicados/${id}`);
  const data = getData();

  const job = await data.jobs.getById(id);
  if (!job) notFound();

  // Una URL ajena no da acceso: quien no es el dueño va al detalle público.
  if (job.clientId !== session.id) redirect(`/trabajos/${id}`);

  const [offers, timeline, assignment] = await Promise.all([
    data.jobs.listOffers(job.id),
    data.jobs.getTimeline(job.id),
    data.jobs.getAssignmentByJob(job.id),
  ]);

  const permissions = jobPermissions(job.status, "client");
  const status = jobStatusLabels[job.status];
  const pendingOffers = offers.filter((o) => o.status === "PENDING");

  return (
    <div className="container-page py-6 sm:py-10">
      <Link
        href="/mis-trabajos/publicados"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-600 hover:text-brand-700"
      >
        <ChevronLeft size={16} aria-hidden="true" />
        Mis trabajos publicados
      </Link>

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
            {status.description && (
              <p className="mt-1.5 text-sm text-ink-600">{status.description}</p>
            )}
          </header>

          {permissions.needsPayment && assignment && (
            <Alert tone="warning" title="Falta confirmar el pago">
              El trabajo no puede comenzar hasta que el pago esté confirmado.{" "}
              <Link
                href={`/pagar/${assignment.assignment.id}`}
                className="font-medium underline underline-offset-2"
              >
                Ir al pago
              </Link>
            </Alert>
          )}

          <Card>
            <CardContent className="space-y-6">
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
                    {formatDuration(job.estimatedDurationMinutes)} estimadas
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

              {job.objective.bonus && (
                <div className="flex gap-3 rounded-[var(--radius-control)] bg-success-50 p-4">
                  <Gift size={18} className="mt-0.5 shrink-0 text-success-600" aria-hidden="true" />
                  <div className="text-sm">
                    <p className="font-medium text-success-800">
                      Bono por objetivo: <Amount value={job.objective.bonus} />
                    </p>
                    {job.objective.bonusConditions && (
                      <p className="mt-1 text-success-700">{job.objective.bonusConditions}</p>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {timeline.length > 0 && (
            <Card>
              <CardContent>
                <h2 className="text-base font-semibold text-ink-900">Avance del trabajo</h2>
                <div className="mt-5">
                  <JobTimeline entries={timeline} timezone={job.timezone} />
                </div>
              </CardContent>
            </Card>
          )}

          <section>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink-900">
              <Users size={18} aria-hidden="true" className="text-ink-400" />
              Ofertas recibidas ({offers.length})
            </h2>

            {offers.length === 0 ? (
              <p className="mt-3 text-sm text-ink-500">
                Todavía no tienes ofertas. Los trabajadores verificados de la zona ya pueden ver tu
                publicación.
              </p>
            ) : (
              <>
                {permissions.canAcceptOffer && pendingOffers.length > 1 && (
                  <p className="mt-2 text-sm text-ink-500">
                    Compara reputación, puntualidad y precio. Aceptar una descarta las demás.
                  </p>
                )}
                <ul className="mt-4 space-y-4">
                  {offers.map((offer) => (
                    <li key={offer.id}>
                      <OfferCard
                        offer={offer}
                        timezone={job.timezone}
                        canAccept={permissions.canAcceptOffer}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>

        <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <Card>
            <CardContent>
              <p className="text-sm text-ink-500">Presupuesto propuesto</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight text-ink-900">
                <Amount value={job.proposedTotal} />
              </p>
              <p className="mt-1 text-sm text-ink-500">
                <HourlyRate value={job.proposedHourlyRate} /> ·{" "}
                {formatDuration(job.estimatedDurationMinutes)}
              </p>

              <div className="mt-5 space-y-2.5">
                {assignment && (
                  <ButtonLink href={`/mis-trabajos/${assignment.assignment.id}`} fullWidth>
                    Ver trabajo asignado
                  </ButtonLink>
                )}
                {permissions.canEdit && (
                  <ButtonLink
                    href={`/mis-trabajos/publicados/${job.id}/editar`}
                    variant="outline"
                    fullWidth
                  >
                    Editar trabajo
                  </ButtonLink>
                )}
                {permissions.canCancel && <CancelJobButton jobId={job.id} />}
              </div>

              {!permissions.canEdit && !assignment && (
                <p className="mt-3 text-xs text-ink-500">
                  Un trabajo con oferta aceptada ya no se puede editar: hay alguien que organizó su
                  día con estos datos.
                </p>
              )}
            </CardContent>
          </Card>

          {assignment && (
            <Card>
              <CardContent>
                <p className="text-sm font-medium text-ink-900">Trabajador asignado</p>
                <p className="mt-2 text-sm text-ink-600">
                  {assignment.worker.profile.displayName}
                </p>
                {assignment.conversationId && (
                  <ButtonLink
                    href={`/mensajes/${assignment.conversationId}`}
                    variant="outline"
                    size="sm"
                    className="mt-3"
                  >
                    Abrir conversación
                  </ButtonLink>
                )}
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
