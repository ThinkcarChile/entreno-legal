import Link from "next/link";

import { Clock, Gift, MapPin, Moon, Users } from "lucide-react";

import { Amount, Badge, Card, CardContent, HourlyRate } from "@/components/ui";
import { urgencyLabels } from "@/lib/domain/labels";
import { JobUrgency } from "@/lib/domain/enums";
import { formatDateTime, formatDuration, formatRelative } from "@/lib/utils/datetime";

import type { JobSummary } from "@/lib/domain/types";

export function JobCard({ job }: { job: JobSummary }) {
  return (
    <Card className="transition-shadow hover:shadow-[var(--shadow-raised)]">
      <CardContent className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">{job.categoryName}</Badge>
          {job.isOvernight && (
            <Badge tone="neutral" icon={<Moon size={12} aria-hidden="true" />}>
              Overnight
            </Badge>
          )}
          {job.urgency === JobUrgency.URGENTE && (
            <Badge tone={urgencyLabels.URGENTE.tone}>{urgencyLabels.URGENTE.label}</Badge>
          )}
          {job.bonus && (
            <Badge tone="success" icon={<Gift size={12} aria-hidden="true" />}>
              Bono <Amount value={job.bonus} />
            </Badge>
          )}
        </div>

        <h3 className="mt-3.5 text-base font-semibold text-ink-950">
          <Link href={`/trabajos/${job.id}`} className="hover:text-brand-700">
            <span className="absolute inset-0" aria-hidden="true" />
            {job.title}
          </Link>
        </h3>

        <dl className="mt-3 space-y-1.5 text-small text-ink-600">
          <div className="flex items-center gap-2">
            <MapPin size={15} className="shrink-0 text-ink-400" aria-hidden="true" />
            <dd>
              {job.communeName}, {job.regionName}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <Clock size={15} className="shrink-0 text-ink-400" aria-hidden="true" />
            <dd>
              {formatDateTime(job.startsAt, job.timezone)} ·{" "}
              {formatDuration(job.estimatedDurationMinutes)}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <Users size={15} className="shrink-0 text-ink-400" aria-hidden="true" />
            <dd>
              {job.offerCount === 0
                ? "Sin ofertas todavía"
                : `${job.offerCount} ${job.offerCount === 1 ? "oferta" : "ofertas"}`}
            </dd>
          </div>
        </dl>

        <div className="mt-auto flex items-end justify-between gap-4 border-t border-ink-100 pt-4">
          <div>
            <p className="text-caption text-ink-500">Presupuesto propuesto</p>
            <p className="mt-0.5 text-h3 text-ink-950">
              <Amount value={job.proposedTotal} />
            </p>
            <p className="text-caption text-ink-500">
              <HourlyRate value={job.proposedHourlyRate} />
            </p>
          </div>
          {job.publishedAt && (
            <p className="text-caption text-ink-500">{formatRelative(job.publishedAt)}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
