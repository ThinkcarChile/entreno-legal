import * as React from "react";

import { cn } from "@/lib/utils/cn";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-line bg-surface px-6 py-14 text-center",
        className,
      )}
    >
      {icon && <div className="mb-4 text-ink-400">{icon}</div>}
      <h3 className="text-base font-semibold text-ink-950">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-small text-ink-500">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
