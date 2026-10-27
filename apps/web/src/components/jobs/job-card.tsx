import Link from "next/link";

import { ArrowRight, Clock, Gift, MapPin, Moon, Users } from "lucide-react";

import { Amount, Badge, Card, CardContent, HourlyRate } from "@/components/ui";
import { urgencyLabels } from "@/lib/domain/labels";
import { JobUrgency } from "@/lib/domain/enums";
import { formatDateTime, formatDuration, formatRelative } from "@/lib/utils/datetime";

import type { JobSummary } from "@/lib/domain/types";

export function JobCard({ job }: { job: JobSummary }) {
  return (
    <Card className="transition-[border-color,box-shadow] hover:border-brand-200 hover:shadow-[var(--shadow-raised)]">
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

        <h3 className="mt-3.5 text-h3 text-ink-950">
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

        <div className="mt-auto flex items-end justify-between gap-4 border-t border-line pt-4">
          <div>
            <p className="text-caption text-ink-500">Tarifa propuesta</p>
            <p className="mt-0.5 text-[1.5rem] leading-tight font-extrabold tracking-[-0.05em] text-ink-950">
              <HourlyRate value={job.proposedHourlyRate} />
            </p>
            <p className="text-caption text-ink-500">
              Total <Amount value={job.proposedTotal} />
              {job.publishedAt && <> · {formatRelative(job.publishedAt)}</>}
            </p>
          </div>
          {/* Toda la tarjeta es el enlace; esto solo lo hace evidente. */}
          <span
            aria-hidden="true"
            className="inline-flex h-9 shrink-0 items-center gap-1 rounded-[var(--radius-chip)] bg-brand-50 px-3 text-small font-bold text-brand-950"
          >
            Ver trabajo
            <ArrowRight size={14} />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
