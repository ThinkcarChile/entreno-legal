import {
  Camera,
  CheckCircle2,
  Flag,
  MapPin,
  MessageSquare,
  Users,
  type LucideIcon,
} from "lucide-react";

import { EvidenceType } from "@/lib/domain/enums";
import { formatTime } from "@/lib/utils/datetime";

import type { JobTimelineEntry } from "@/lib/domain/types";

const icons: Record<string, LucideIcon> = {
  [EvidenceType.CHECK_IN]: CheckCircle2,
  [EvidenceType.PHOTO]: Camera,
  [EvidenceType.NOTE]: MessageSquare,
  [EvidenceType.LOCATION]: MapPin,
  [EvidenceType.QUEUE_STATUS]: Users,
  [EvidenceType.HANDOFF]: Flag,
  [EvidenceType.SYSTEM]: Flag,
};

/**
 * Línea de tiempo del trabajo.
 *
 * Las entradas son evidencia: no se editan ni se borran. Un cambio se registra como
 * una entrada nueva, nunca reescribiendo la anterior.
 */
export function JobTimeline({
  entries,
  timezone,
}: {
  entries: readonly JobTimelineEntry[];
  timezone: string;
}) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        Aquí aparecerá el avance del trabajo: llegada, check-in, actualizaciones y entrega.
      </p>
    );
  }

  return (
    <ol className="relative space-y-6 border-l border-ink-200 pl-6">
      {entries.map((entry) => {
        const Icon = icons[entry.type] ?? MessageSquare;
        return (
          <li key={entry.id} className="relative">
            <span className="absolute top-0.5 -left-[2.1875rem] inline-flex h-6 w-6 items-center justify-center rounded-full bg-white ring-1 ring-ink-200">
              <Icon size={13} className="text-brand-600" aria-hidden="true" />
            </span>
            <div className="flex flex-wrap items-baseline gap-x-2.5">
              <time
                dateTime={entry.occurredAt}
                className="text-sm font-semibold text-ink-900 tabular-nums"
              >
                {formatTime(entry.occurredAt, timezone)}
              </time>
              <p className="text-sm font-medium text-ink-900">{entry.title}</p>
            </div>
            {entry.body && <p className="mt-1 text-sm text-ink-600">{entry.body}</p>}
            {entry.authorName && (
              <p className="mt-1 text-xs text-ink-400">Registrado por {entry.authorName}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
