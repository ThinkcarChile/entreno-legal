import Link from "next/link";

import { BadgeCheck, Clock3, MessageSquare } from "lucide-react";

import { LevelBadge } from "@/components/profile/level-badge";
import { Amount, Avatar, Badge, Button, Card, CardContent, HourlyRate, Rating } from "@/components/ui";
import { OfferStatus, VerificationStatus } from "@/lib/domain/enums";
import { offerStatusLabels } from "@/lib/domain/labels";
import { formatTime } from "@/lib/utils/datetime";
import { formatPercent } from "@/lib/utils/format";

import type { JobOffer } from "@/lib/domain/types";

export function OfferCard({ offer, timezone }: { offer: JobOffer; timezone: string }) {
  const { worker } = offer;
  const verified = worker.verificationStatus === VerificationStatus.VERIFIED;
  const status = offerStatusLabels[offer.status];

  return (
    <Card>
      <CardContent>
        <div className="flex items-start gap-3.5">
          <Avatar src={worker.profile.avatarUrl} name={worker.profile.displayName} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link
                href={`/trabajadores/${worker.userId}`}
                className="font-semibold text-ink-900 hover:text-brand-700"
              >
                {worker.profile.displayName}
              </Link>
              {verified && (
                <BadgeCheck
                  size={15}
                  className="text-brand-600"
                  aria-label="Identidad verificada"
                />
              )}
              <LevelBadge level={worker.level} />
              {offer.status !== OfferStatus.PENDING && (
                <Badge tone={status.tone}>{status.label}</Badge>
              )}
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-500">
              {worker.reputation.reviewCount > 0 && (
                <Rating
                  value={worker.reputation.averageRating}
                  count={worker.reputation.reviewCount}
                />
              )}
              <span>{worker.reputation.completedJobs} trabajos</span>
              <span>Puntualidad {formatPercent(worker.reputation.punctualityRate)}</span>
            </div>
          </div>

          <div className="shrink-0 text-right">
            <p className="text-lg font-semibold text-ink-900">
              <HourlyRate value={offer.hourlyRate} />
            </p>
            <p className="text-sm text-ink-500">
              Total <Amount value={offer.estimatedTotal} />
            </p>
          </div>
        </div>

        {offer.message && (
          <p className="mt-4 rounded-[var(--radius-control)] bg-ink-50 px-4 py-3 text-sm leading-relaxed text-ink-700">
            {offer.message}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          {offer.estimatedArrivalAt && (
            <p className="flex items-center gap-1.5 text-sm text-ink-500">
              <Clock3 size={14} aria-hidden="true" />
              Puede llegar a las {formatTime(offer.estimatedArrivalAt, timezone)}
            </p>
          )}

          {offer.status === OfferStatus.PENDING && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm">
                <MessageSquare size={15} aria-hidden="true" />
                Conversar
              </Button>
              <Button size="sm">Aceptar oferta</Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
