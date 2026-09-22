import Link from "next/link";

import { BadgeCheck, Clock } from "lucide-react";

import { Avatar, Card, CardContent, HourlyRate, Rating } from "@/components/ui";
import { VerificationStatus } from "@/lib/domain/enums";
import { formatPercent } from "@/lib/utils/format";

import { LevelBadge } from "./level-badge";

import type { WorkerProfile } from "@/lib/domain/types";

export function WorkerCard({ worker }: { worker: WorkerProfile }) {
  const verified = worker.verificationStatus === VerificationStatus.VERIFIED;

  return (
    <Card className="transition-shadow hover:shadow-[var(--shadow-raised)]">
      <CardContent className="flex h-full flex-col">
        <div className="flex items-start gap-3.5">
          <Avatar src={worker.profile.avatarUrl} name={worker.profile.displayName} size="lg" />
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-1.5 font-semibold text-ink-950">
              <Link
                href={`/trabajadores/${worker.userId}`}
                className="truncate hover:text-brand-700"
              >
                {worker.profile.displayName}
              </Link>
              {verified && (
                <BadgeCheck
                  size={16}
                  className="shrink-0 text-brand-600"
                  aria-label="Identidad verificada"
                />
              )}
            </h3>
            <p className="mt-0.5 truncate text-small text-ink-500">{worker.profile.city}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <LevelBadge level={worker.level} />
              {worker.reputation.reviewCount > 0 && (
                <Rating
                  value={worker.reputation.averageRating}
                  count={worker.reputation.reviewCount}
                />
              )}
            </div>
          </div>
        </div>

        {worker.headline && (
          <p className="mt-4 line-clamp-2 text-small text-ink-600">{worker.headline}</p>
        )}

        <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-ink-100 pt-4 text-center">
          <div>
            <dt className="text-caption text-ink-500">Trabajos</dt>
            <dd className="mt-0.5 text-small font-semibold text-ink-950 tabular-nums">
              {worker.reputation.completedJobs}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-ink-500">Puntualidad</dt>
            <dd className="mt-0.5 text-small font-semibold text-ink-950 tabular-nums">
              {formatPercent(worker.reputation.punctualityRate)}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-ink-500">Confianza</dt>
            <dd className="mt-0.5 text-small font-semibold text-ink-950 tabular-nums">
              {worker.trustIndex}
            </dd>
          </div>
        </dl>

        <div className="mt-auto flex items-center justify-between gap-3 border-t border-ink-100 pt-4">
          <span className="flex items-center gap-1.5 text-small text-ink-500">
            <Clock size={14} aria-hidden="true" />
            Desde
          </span>
          <HourlyRate value={worker.baseHourlyRate} className="font-semibold text-ink-950" />
        </div>
      </CardContent>
    </Card>
  );
}
