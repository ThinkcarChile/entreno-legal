import { Star } from "lucide-react";

import { cn } from "@/lib/utils/cn";
import { formatRating } from "@/lib/utils/format";

export interface RatingProps {
  value: number;
  count?: number;
  size?: "sm" | "md";
  showCount?: boolean;
  className?: string;
}

export function Rating({ value, count, size = "sm", showCount = true, className }: RatingProps) {
  const iconSize = size === "sm" ? 14 : 16;

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Star
        size={iconSize}
        className="fill-warning-500 text-warning-500"
        aria-hidden="true"
      />
      <span
        className={cn("font-semibold text-ink-900", size === "sm" ? "text-sm" : "text-base")}
      >
        {formatRating(value)}
      </span>
      {showCount && typeof count === "number" && (
        <span className={cn("text-ink-500", size === "sm" ? "text-sm" : "text-base")}>
          ({count})
        </span>
      )}
    </span>
  );
}

/** Estrellas individuales, para el detalle de una reseña. */
export function StarRow({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-ink-600">{label}</span>
      <span className="flex items-center gap-0.5" aria-label={`${value} de 5`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <Star
            key={i}
            size={13}
            aria-hidden="true"
            className={cn(
              i <= Math.round(value)
                ? "fill-warning-500 text-warning-500"
                : "fill-ink-200 text-ink-200",
            )}
          />
        ))}
      </span>
    </div>
  );
}
