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
  info: { chip: "bg-brand-50 text-brand-700 ring-brand-100", dot: "bg-brand-500" },
  success: { chip: "bg-success-50 text-success-800 ring-success-100", dot: "bg-success-500" },
  warning: { chip: "bg-warning-50 text-warning-800 ring-warning-100", dot: "bg-warning-500" },
  danger: { chip: "bg-danger-50 text-danger-700 ring-danger-100", dot: "bg-danger-500" },
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
        "inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 text-caption font-medium ring-1 ring-inset",
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
