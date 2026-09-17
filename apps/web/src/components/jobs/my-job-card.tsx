import Link from "next/link";

import { Clock, MapPin, Users } from "lucide-react";

import { Amount, Badge, Card, CardContent } from "@/components/ui";
import { assignmentStatusLabels, jobStatusLabels, offerStatusLabels } from "@/lib/domain/labels";
import { formatDateTime, formatDuration } from "@/lib/utils/datetime";

import type { ClientJobSummary, WorkerJobSummary } from "@/lib/domain/types";

/** Tarjeta de un trabajo propio, vista por el cliente que lo publicó. */
export function ClientJobCard({ job }: { job: ClientJobSummary }) {
  const status = job.assignmentStatus
    ? assignmentStatusLabels[job.assignmentStatus]
    : jobStatusLabels[job.status];

  return (
    <Card className="w-full transition-shadow hover:shadow-[var(--shadow-raised)]">
      <CardContent className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="text-xs text-ink-400">{job.reference}</span>
        </div>

        <h3 className="mt-3 font-semibold text-ink-900">
          <Link href={`/mis-trabajos/publicados/${job.id}`} className="hover:text-brand-700">
            <span className="absolute inset-0" aria-hidden="true" />
            {job.title}
          </Link>
        </h3>

        <dl className="mt-3 space-y-1.5 text-sm text-ink-600">
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
              {job.workerDisplayName
                ? `Asignado a ${job.workerDisplayName}`
                : job.offerCount === 0
                  ? "Sin ofertas todavía"
                  : `${job.offerCount} ${job.offerCount === 1 ? "oferta" : "ofertas"}`}
            </dd>
          </div>
        </dl>

        <div className="mt-auto border-t border-ink-100 pt-4">
          <p className="text-xs text-ink-500">Presupuesto</p>
          <p className="mt-0.5 text-lg font-semibold text-ink-900">
            <Amount value={job.proposedTotal} />
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Tarjeta de un trabajo en el que el usuario ofertó o fue asignado. */
export function WorkerJobCard({ job }: { job: WorkerJobSummary }) {
  const status = job.assignmentStatus
    ? assignmentStatusLabels[job.assignmentStatus]
    : job.offerStatus
      ? offerStatusLabels[job.offerStatus]
      : jobStatusLabels[job.status];

  const href = job.assignmentId ? `/mis-trabajos/${job.assignmentId}` : `/trabajos/${job.id}`;

  return (
    <Card className="w-full transition-shadow hover:shadow-[var(--shadow-raised)]">
      <CardContent className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="text-xs text-ink-400">{job.reference}</span>
        </div>

        <h3 className="mt-3 font-semibold text-ink-900">
          <Link href={href} className="hover:text-brand-700">
            <span className="absolute inset-0" aria-hidden="true" />
            {job.title}
          </Link>
        </h3>

        <dl className="mt-3 space-y-1.5 text-sm text-ink-600">
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
        </dl>

        <div className="mt-auto border-t border-ink-100 pt-4">
          <p className="text-xs text-ink-500">Tu oferta</p>
          <p className="mt-0.5 text-lg font-semibold text-ink-900">
            {job.offerHourlyRate ? <Amount value={job.offerHourlyRate} /> : "—"}
            <span className="text-sm font-normal text-ink-500">/h</span>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
