import * as React from "react";

import { cn } from "@/lib/utils/cn";

import type { ToneName } from "@/lib/domain/labels";

const tones: Record<ToneName, string> = {
  neutral: "bg-ink-100 text-ink-700 ring-ink-200",
  info: "bg-brand-50 text-brand-700 ring-brand-100",
  success: "bg-success-50 text-success-700 ring-success-100",
  warning: "bg-warning-50 text-warning-700 ring-warning-100",
  danger: "bg-danger-50 text-danger-700 ring-danger-100",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: ToneName;
  icon?: React.ReactNode;
}

export function Badge({ className, tone = "neutral", icon, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
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
