import { cn } from "@/lib/utils/cn";

import type { ToneName } from "@/lib/domain/labels";

/**
 * Estado de algo, con forma además de color.
 *
 * El punto de la izquierda no es decoración: es lo que permite distinguir un
 * estado de otro sin depender del color, que es el requisito de accesibilidad
 * que más se incumple en paneles como este.
 */
const tones: Record<ToneName, { chip: string; dot: string }> = {
  neutral: { chip: "bg-ink-100 text-ink-700 ring-ink-200", dot: "bg-ink-500" },
  info: { chip: "bg-info-100 text-info-700 ring-info-200", dot: "bg-info-500" },
  success: { chip: "bg-brand-100 text-success-800 ring-success-200", dot: "bg-success-500" },
  warning: { chip: "bg-warning-100 text-warning-800 ring-warning-200", dot: "bg-warning-500" },
  danger: { chip: "bg-danger-100 text-danger-700 ring-danger-200", dot: "bg-danger-500" },
};

export function StatusChip({
  tone = "neutral",
  children,
  className,
  pulse,
}: {
  tone?: ToneName;
  children: React.ReactNode;
  className?: string;
  /** Para lo que está ocurriendo ahora mismo, como un trabajo en curso. */
  pulse?: boolean;
}) {
  const style = tones[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 text-[0.75rem] font-bold ring-1 ring-inset",
        style.chip,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          style.dot,
          pulse && "motion-safe:animate-pulse",
        )}
      />
      {children}
    </span>
  );
}
