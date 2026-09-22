import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BadgeCheck, CalendarDays, Clock, MapPin, Phone, Wallet } from "lucide-react";

import { LevelBadge } from "@/components/profile/level-badge";
import { ReviewCard } from "@/components/profile/review-card";
import { TrustIndexCard } from "@/components/profile/trust-index";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  HourlyRate,
  Rating,
  Stat,
} from "@/components/ui";
import { VerificationStatus } from "@/lib/domain/enums";
import { verificationStatusLabels } from "@/lib/domain/labels";
import { getData } from "@/lib/data";
import { regionName } from "@/lib/geo/chile";
import { computeTrustIndex, nextLevelGap } from "@/lib/reputation";
import { formatDate, formatDuration } from "@/lib/utils/datetime";
import { formatPercent } from "@/lib/utils/format";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const worker = await getData().workers.getByUserId(id);
  if (!worker) return { title: "Perfil no encontrado" };

  return {
    title: `${worker.profile.displayName} — Trabajador verificado`,
    description:
      worker.headline ??
      `Perfil de ${worker.profile.displayName} en HagoTuFila: reputación, puntualidad y trabajos completados.`,
    alternates: { canonical: `/trabajadores/${worker.userId}` },
  };
}

export default async function WorkerProfilePage({ params }: PageProps) {
  const { id } = await params;
  const data = getData();

  const worker = await data.workers.getByUserId(id);
  if (!worker) notFound();

  const reviews = await data.workers.listReviews(worker.userId, 6);
  const trust = computeTrustIndex({
    reputation: worker.reputation,
    trust: worker.trust,
    verificationStatus: worker.verificationStatus,
  });
  const gap = nextLevelGap({
    reputation: worker.reputation,
    verificationStatus: worker.verificationStatus,
    trustIndex: worker.trustIndex,
  });

  const verified = worker.verificationStatus === VerificationStatus.VERIFIED;
  const status = verificationStatusLabels[worker.verificationStatus];

  return (
    <div className="container-page py-8 sm:py-12">
      <div className="grid gap-8 lg:grid-cols-[1.6fr_1fr] lg:gap-10">
        <div className="space-y-6">
          <Card>
            <CardContent>
              <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                <Avatar
                  src={worker.profile.avatarUrl}
                  name={worker.profile.displayName}
                  size="xl"
                />
                <div className="min-w-0 flex-1">
                  <h1 className="flex flex-wrap items-center gap-2 text-h2 text-ink-950">
                    {worker.profile.displayName}
                    {verified && (
                      <BadgeCheck
                        size={20}
                        className="text-brand-600"
                        aria-label="Identidad verificada"
                      />
                    )}
                  </h1>

                  {worker.headline && <p className="mt-1.5 text-ink-600">{worker.headline}</p>}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <LevelBadge level={worker.level} />
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {worker.reputation.reviewCount > 0 && (
                      <Rating
                        value={worker.reputation.averageRating}
                        count={worker.reputation.reviewCount}
                        size="md"
                      />
                    )}
                  </div>

                  <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-small text-ink-600">
                    <div className="flex items-center gap-1.5">
                      <MapPin size={15} className="text-ink-400" aria-hidden="true" />
                      <dd>
                        {worker.profile.city}
                        {worker.profile.regionCode
                          ? `, ${regionName(worker.profile.regionCode)}`
                          : ""}
                      </dd>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <CalendarDays size={15} className="text-ink-400" aria-hidden="true" />
                      <dd className="first-letter:uppercase">
                        En HagoTuFila desde {formatDate(worker.profile.memberSince, undefined, "MMMM yyyy")}
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>

              {worker.profile.bio && (
                <p className="mt-6 text-[0.9375rem] leading-relaxed text-ink-700">
                  {worker.profile.bio}
                </p>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Trabajos completados" value={worker.reputation.completedJobs} />
            <Stat
              label="Horas trabajadas"
              value={formatDuration(worker.reputation.workedMinutes).replace(" min", "")}
            />
            <Stat
              label="Puntualidad"
              value={formatPercent(worker.reputation.punctualityRate)}
            />
            <Stat
              label="Cumplimiento"
              value={formatPercent(worker.reputation.completionRate)}
              hint={`${worker.reputation.cancellationCount} cancelaciones`}
            />
          </div>

          <Card>
            <CardContent>
              <h2 className="text-base font-semibold text-ink-950">Verificaciones</h2>
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                <TrustRow
                  icon={<BadgeCheck size={16} aria-hidden="true" />}
                  label="Identidad verificada"
                  ok={worker.trust.identityVerified}
                />
                <TrustRow
                  icon={<Phone size={16} aria-hidden="true" />}
                  label="Teléfono verificado"
                  ok={worker.trust.phoneVerified}
                />
                <TrustRow
                  icon={<Wallet size={16} aria-hidden="true" />}
                  label="Cuenta bancaria verificada"
                  ok={worker.trust.bankAccountVerified}
                />
                <TrustRow
                  icon={<Clock size={16} aria-hidden="true" />}
                  label="Acepta trabajos nocturnos"
                  ok={worker.acceptsOvernight}
                />
              </ul>
              <p className="mt-4 text-caption text-ink-500">
                Los datos personales (RUT, documento, teléfono y cuenta bancaria) nunca se
                muestran públicamente.
              </p>
            </CardContent>
          </Card>

          <section>
            <h2 className="text-base font-semibold text-ink-950">
              Reseñas ({worker.reputation.reviewCount})
            </h2>
            {reviews.length === 0 ? (
              <p className="mt-3 text-small text-ink-500">Todavía no tiene reseñas publicadas.</p>
            ) : (
              <ul className="mt-4 grid gap-4 sm:grid-cols-2">
                {reviews.map((review) => (
                  <li key={review.id}>
                    <ReviewCard review={review} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <Card>
            <CardContent>
              <p className="text-small text-ink-500">Tarifa de referencia</p>
              <p className="mt-1 text-h1 text-ink-950">
                <HourlyRate value={worker.baseHourlyRate} />
              </p>
              {worker.availabilityNote && (
                <p className="mt-2 text-small text-ink-600">{worker.availabilityNote}</p>
              )}
              <Button fullWidth size="lg" className="mt-5" disabled={!worker.isAcceptingJobs}>
                {worker.isAcceptingJobs ? "Invitar a un trabajo" : "No disponible por ahora"}
              </Button>
              <p className="mt-3 text-caption text-ink-500">
                La tarifa final la define su oferta para cada trabajo.
              </p>
            </CardContent>
          </Card>

          <TrustIndexCard result={trust} />

          {gap && gap.missing.length > 0 && (
            <Card>
              <CardContent>
                <p className="text-small font-medium text-ink-950">
                  Camino al nivel {gap.next.toLowerCase()}
                </p>
                <ul className="mt-3 space-y-1.5 text-small text-ink-600">
                  {gap.missing.map((item) => (
                    <li key={item}>· {item}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent>
              <p className="text-small font-medium text-ink-950">Zonas de trabajo</p>
              <ul className="mt-3 space-y-1.5 text-small text-ink-600">
                {worker.serviceAreas.map((area) => (
                  <li key={area.id}>
                    {regionName(area.regionCode)}
                    {area.radiusKm ? ` · hasta ${area.radiusKm} km` : ""}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function TrustRow({
  icon,
  label,
  ok,
}: {
  icon: React.ReactNode;
  label: string;
  ok: boolean;
}) {
  return (
    <li className="flex items-center gap-2.5 text-small">
      <span className={ok ? "text-success-600" : "text-ink-300"}>{icon}</span>
      <span className={ok ? "text-ink-800" : "text-ink-500"}>{label}</span>
      {!ok && <span className="ml-auto text-caption text-ink-500">Pendiente</span>}
    </li>
  );
}
