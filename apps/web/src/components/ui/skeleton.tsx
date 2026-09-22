import { cn } from "@/lib/utils/cn";

/** Hueco con la forma del contenido que viene. Evita el salto al cargar. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-[var(--radius-control)] bg-ink-100", className)}
    />
  );
}

export function JobCardSkeleton() {
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <Skeleton className="h-5 w-24 rounded-full" />
      <Skeleton className="mt-3.5 h-5 w-full" />
      <Skeleton className="mt-2 h-4 w-3/4" />
      <div className="mt-4 space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="mt-5 border-t border-ink-100 pt-4">
        <Skeleton className="h-6 w-28" />
      </div>
    </div>
  );
}

export function JobListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <li key={i}>
          <JobCardSkeleton />
        </li>
      ))}
    </ul>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-[var(--radius-card)]" />
      ))}
    </div>
  );
}
