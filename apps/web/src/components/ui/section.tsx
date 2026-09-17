import * as React from "react";

import { cn } from "@/lib/utils/cn";

export interface SectionProps extends React.HTMLAttributes<HTMLElement> {
  eyebrow?: string;
  title?: string;
  description?: string;
  align?: "left" | "center";
  action?: React.ReactNode;
  contained?: boolean;
}

export function Section({
  eyebrow,
  title,
  description,
  align = "left",
  action,
  contained = true,
  className,
  children,
  ...props
}: SectionProps) {
  const header = title || eyebrow || description;

  return (
    <section className={cn("py-14 sm:py-20", className)} {...props}>
      <div className={contained ? "container-page" : undefined}>
        {header && (
          <div
            className={cn(
              "mb-8 flex flex-col gap-4 sm:mb-12 sm:flex-row sm:items-end sm:justify-between",
              align === "center" && "sm:flex-col sm:items-center sm:text-center",
            )}
          >
            <div className={cn("max-w-2xl", align === "center" && "mx-auto text-center")}>
              {eyebrow && (
                <p className="text-sm font-semibold tracking-wide text-brand-600 uppercase">
                  {eyebrow}
                </p>
              )}
              {title && (
                <h2 className="mt-2 text-2xl font-semibold text-ink-900 sm:text-3xl">{title}</h2>
              )}
              {description && (
                <p className="mt-3 text-base text-ink-600 sm:text-lg">{description}</p>
              )}
            </div>
            {action && <div className="shrink-0">{action}</div>}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
