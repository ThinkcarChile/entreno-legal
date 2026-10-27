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
        "flex flex-col items-center justify-center rounded-[1.25rem] border border-dashed border-line-strong bg-surface px-6 py-14 text-center sm:py-16",
        className,
      )}
    >
      {icon && (
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-[1.125rem] bg-brand-100 text-brand-700">
          {icon}
        </div>
      )}
      <h3 className="text-h3 text-ink-950">{title}</h3>
      {description && <p className="mt-2 max-w-md text-small text-ink-500">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
