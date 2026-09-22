import * as React from "react";

import { cn } from "@/lib/utils/cn";

export interface StatProps {
  label: string;
  value: React.ReactNode;
  hint?: string;
  className?: string;
}

export function Stat({ label, value, hint, className }: StatProps) {
  return (
    <div className={cn("rounded-[var(--radius-card)] border border-line bg-surface p-5", className)}>
      <p className="text-small text-ink-500">{label}</p>
      <p className="mt-1.5 text-h2 text-ink-950 tabular-nums">
        {value}
      </p>
      {hint && <p className="mt-1 text-caption text-ink-500">{hint}</p>}
    </div>
  );
}
