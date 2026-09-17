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
    <div className={cn("rounded-[var(--radius-card)] border border-ink-200/70 bg-white p-5", className)}>
      <p className="text-sm text-ink-500">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight text-ink-900 tabular-nums">
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}
