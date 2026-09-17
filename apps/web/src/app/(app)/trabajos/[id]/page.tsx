import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  CalendarClock,
  ChevronLeft,
  Gift,
  Info,
  Moon,
  ShieldCheck,
  Target,
  Users,
} from "lucide-react";

import { JobLocationBlock } from "@/components/jobs/job-location";
import { JobTimeline } from "@/components/jobs/job-timeline";
import { OfferCard } from "@/components/jobs/offer-card";
import { OfferForm } from "@/components/jobs/offer-form";
import { PriceHint } from "@/components/jobs/price-hint";
import {
  Amount,
  Avatar,
  Badge,
  ButtonLink,
  Card,
  CardContent,
  HourlyRate,
} from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { site } from "@/config/site";
import { getSession } from "@/lib/auth/session";
import { canSendOffers } from "@/lib/domain/eligibility";
import { isOpen } from "@/lib/domain/job-actions";
import { JobObjectiveType, UserRole } from "@/lib/domain/enums";
import { jobStatusLabels, urgencyLabels } from "@/lib/domain/labels";
import { getData } from "@/lib/data";
import { getPricingEngine } from "@/lib/pricing";
import { formatDate, formatDuration, formatTime } from "@/lib/utils/datetime";

import type { Job } from "@/lib/domain/types";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const job = await getData().jobs.getById(id);
  if (!job) return { title: "Trabajo no encontrado" };

  return {
    title: job.title,
    description: job.description.slice(0, 160),
    alternates: { canonical: `/trabajos/${job.id}` },
    openGraph: {
      title: job.title,
      description: job.description.slice(0, 200),
      type: "article",
    },
  };
}

export default async function JobDetailPage({ params }: PageProps) {
  const { id } = await params;
  const data = getData();

  const job = await data.jobs.getById(id);
  if (!job) notFound();

  const [offers, timeline, session] = await Promise.all([
    data.jobs.listOffers(job.id),
    data.jobs.getTimeline(job.id),
    getSession(),
  ]);

  const isOwner = session?.id === job.clientId;
  const myOffer = session && !isOwner ? await data.jobs.getMyOffer(job.id) : null;
  const eligibility = canSendOffers(session?.worker ?? null);
  const isWorkerMode = session?.modes.includes(UserRole.WORKER) ?? false;

  const suggestion = getPricingEngine().suggest({
    categoryGroup: job.category.group,
    categoryId: job.category.id,
    categoryBase: {
      min: job.category.baseHourlyMin.amount,
      max: job.category.baseHourlyMax.amount,
    },
    regionCode: job.location.regionCode,
    communeCode: job.location.communeCode,
    startsAt: job.startsAt,
    durationMinutes: job.estimatedDurationMinutes,
    urgency: job.urgency,
    timezone: job.timezone,
  });

  const status = jobStatusLabels[job.status];

  return (
    <div className="container-page py-6 sm:py-10">
      <Link
        href="/trabajos"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-600 hover:text-brand-700"
      >
        <ChevronLeft size={16} aria-hidden="true" />
        Volver a trabajos
      </Link>

      <div className="mt-6 grid gap-8 lg:grid-cols-[1.6fr_1fr] lg:gap-10">
        <div className="space-y-6">
          <header>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="info">{job.category.name}</Badge>
              <Badge tone={status.tone}>{status.label}</Badge>
              {job.isOvernight && (
                <Badge icon={<Moon size={12} aria-hidden="true" />}>Overnight</Badge>
              )}
              <Badge tone={urgencyLabels[job.urgency].tone}>
                {urgencyLabels[job.urgency].label}
              </Badge>
              <span className="text-xs text-ink-400">{job.reference}</span>
            </div>

            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">
              {job.title}
            </h1>

            <div className="mt-4 flex items-center gap-3">
              <Avatar src={job.client.avatarUrl} name={job.client.displayName} size="sm" />
              <p className="text-sm text-ink-600">
                Publicado por{" "}
                <span className="font-medium text-ink-900">{job.client.displayName}</span>
              </p>
            </div>
          </header>

          <Card>
            <CardContent className="space-y-6">
              <JobLocationBlock location={job.location} />

              <DetailRow
                icon={<CalendarClock size={18} aria-hidden="true" />}
                label="Cuándo"
                value={
                  <>
                    <span className="block first-letter:uppercase">
                      {formatDate(job.startsAt, job.timezone)}
                    </span>
                    <span className="text-ink-500">
                      Desde las {formatTime(job.startsAt, job.timezone)} ·{" "}
                      {formatDuration(job.estimatedDurationMinutes)} estimadas
                    </span>
                  </>
                }
              />

              <DetailRow
                icon={<Target size={18} aria-hidden="true" />}
                label="Objetivo"
                value={<ObjectiveText job={job} />}
              />

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
                    <p className="mt-2 text-xs text-success-700/80">
                      El bono es adicional al pago por trabajo y se paga solo si el objetivo se
                      cumple.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <h2 className="text-base font-semibold text-ink-900">Descripción</h2>
              <p className="mt-3 text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-700">
                {job.description}
              </p>

              {job.instructions && (
                <>
                  <h3 className="mt-6 text-sm font-semibold text-ink-900">Instrucciones</h3>
                  <p className="mt-2 text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-700">
                    {job.instructions}
                  </p>
                </>
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

          {isOwner && (
            <section>
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink-900">
                <Users size={18} aria-hidden="true" className="text-ink-400" />
                Ofertas recibidas ({offers.length})
              </h2>
              {offers.length === 0 ? (
                <p className="mt-3 text-sm text-ink-500">
                  Todavía no hay ofertas. Los trabajadores verificados de la zona ya pueden verlo.
                </p>
              ) : (
                <ul className="mt-4 space-y-4">
                  {offers.map((offer) => (
                    <li key={offer.id}>
                      <OfferCard offer={offer} timezone={job.timezone} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {!isOwner && (
            <p className="text-sm text-ink-500">
              {job.offerCount === 0
                ? "Todavía nadie ha ofertado. Es un buen momento para postular."
                : `Ya hay ${job.offerCount} ${job.offerCount === 1 ? "oferta" : "ofertas"} para este trabajo.`}
            </p>
          )}
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

              <div className="mt-5">
                {isOwner ? (
                  <ButtonLink href={`/mis-trabajos/publicados/${job.id}`} fullWidth size="lg">
                    Gestionar mi trabajo
                  </ButtonLink>
                ) : !isOpen(job.status) ? (
                  <Alert tone="info">
                    Este trabajo ya no está recibiendo ofertas.
                  </Alert>
                ) : !session ? (
                  <div className="space-y-2.5">
                    <ButtonLink
                      href={`/entrar?next=/trabajos/${job.id}`}
                      fullWidth
                      size="lg"
                    >
                      Entrar para ofertar
                    </ButtonLink>
                    <ButtonLink
                      href="/crear-cuenta?modo=trabajador"
                      variant="outline"
                      fullWidth
                    >
                      Crear cuenta de trabajador
                    </ButtonLink>
                  </div>
                ) : !isWorkerMode ? (
                  <div className="space-y-3">
                    <Alert tone="info">
                      Activa el modo trabajador en tu cuenta para poder ofertar.
                    </Alert>
                    <ButtonLink href="/cuenta/trabajador" variant="outline" fullWidth>
                      Activar modo trabajador
                    </ButtonLink>
                  </div>
                ) : !eligibility.allowed ? (
                  <div className="space-y-3">
                    <Alert tone="warning">{eligibility.message}</Alert>
                    {eligibility.href && (
                      <ButtonLink href={eligibility.href} variant="outline" fullWidth>
                        Continuar
                      </ButtonLink>
                    )}
                  </div>
                ) : (
                  <OfferForm
                    jobId={job.id}
                    workerId={session.id}
                    durationMinutes={job.estimatedDurationMinutes}
                    suggestedHourly={suggestion.recommendedHourly.amount}
                    existingOffer={myOffer}
                  />
                )}
              </div>

              {!isOwner && isOpen(job.status) && (
                <p className="mt-4 flex gap-2 text-xs text-ink-500">
                  <Info size={14} className="mt-px shrink-0" aria-hidden="true" />
                  Propones tu propia tarifa por hora. El cliente elige entre todas las ofertas
                  recibidas.
                </p>
              )}
            </CardContent>
          </Card>

          <PriceHint suggestion={suggestion} />

          <Card>
            <CardContent>
              <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                <ShieldCheck size={16} className="text-success-600" aria-hidden="true" />
                {site.protectedPaymentLabel}
              </p>
              <p className="mt-2 text-sm text-ink-600">
                El cliente paga antes de que el trabajo comience y el dinero queda asociado a
                este servicio. Se aprueba tu pago cuando la entrega se confirma o vence el plazo
                para reportar un problema.
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex gap-3.5">
      <span className="mt-0.5 shrink-0 text-ink-400">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-medium tracking-wide text-ink-500 uppercase">{label}</p>
        <div className="mt-1 text-[0.9375rem] text-ink-700">{value}</div>
      </div>
    </div>
  );
}

function ObjectiveText({ job }: { job: Job }) {
  switch (job.objective.type) {
    case JobObjectiveType.HOLD_PLACE:
      return <>Mantener el lugar en la fila hasta que llegue el cliente.</>;
    case JobObjectiveType.AS_FRONT_AS_POSSIBLE:
      return <>Quedar lo más adelante posible en la fila.</>;
    case JobObjectiveType.WITHIN_FIRST_N:
      return <>Quedar dentro de los primeros {job.objective.targetPosition} de la fila.</>;
    case JobObjectiveType.COMPLETE_ERRAND:
      return <>{job.objective.description ?? "Completar la gestión encargada."}</>;
    default:
      return <>{job.objective.description ?? "Objetivo personalizado."}</>;
  }
}
