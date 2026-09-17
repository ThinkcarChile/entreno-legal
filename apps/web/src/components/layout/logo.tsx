import { site } from "@/config/site";
import { cn } from "@/lib/utils/cn";

/**
 * Marca tipográfica con una marca gráfica simple: dos barras que sugieren una fila
 * y una tercera adelantada, la persona que va por ti.
 */
export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <svg
        width="30"
        height="30"
        viewBox="0 0 30 30"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect width="30" height="30" rx="9" className="fill-brand-600" />
        <rect x="7" y="8" width="3.5" height="14" rx="1.75" className="fill-white/45" />
        <rect x="13.25" y="8" width="3.5" height="14" rx="1.75" className="fill-white/70" />
        <rect x="19.5" y="5" width="3.5" height="20" rx="1.75" className="fill-white" />
      </svg>
      {!compact && (
        <span className="text-[1.0625rem] font-semibold tracking-tight text-ink-900">
          {site.shortName}
        </span>
      )}
    </span>
  );
}
