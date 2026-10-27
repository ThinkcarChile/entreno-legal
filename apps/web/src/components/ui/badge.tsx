import * as React from "react";

import { cn } from "@/lib/utils/cn";

import type { ToneName } from "@/lib/domain/labels";

const tones: Record<ToneName, string> = {
  neutral: "bg-ink-100 text-ink-700 ring-ink-200",
  info: "bg-info-100 text-info-700 ring-info-200",
  success: "bg-brand-100 text-success-800 ring-success-200",
  warning: "bg-warning-100 text-warning-800 ring-warning-200",
  danger: "bg-danger-100 text-danger-700 ring-danger-200",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: ToneName;
  icon?: React.ReactNode;
}

export function Badge({ className, tone = "neutral", icon, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.75rem] font-bold ring-1 ring-inset",
        tones[tone],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}
