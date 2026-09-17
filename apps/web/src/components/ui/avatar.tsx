import Image from "next/image";

import { cn } from "@/lib/utils/cn";

export interface AvatarProps {
  src?: string | null;
  name: string;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

const sizes = {
  sm: { box: "h-8 w-8 text-xs", px: 32 },
  md: { box: "h-11 w-11 text-sm", px: 44 },
  lg: { box: "h-16 w-16 text-lg", px: 64 },
  xl: { box: "h-24 w-24 text-2xl", px: 96 },
} as const;

/** Iniciales cuando no hay foto. Nunca muestra el apellido completo. */
function initialsFrom(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

export function Avatar({ src, name, size = "md", className }: AvatarProps) {
  const config = sizes[size];

  if (src) {
    return (
      <Image
        src={src}
        alt={name}
        width={config.px}
        height={config.px}
        className={cn("rounded-full object-cover", config.box, className)}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-brand-50 font-semibold text-brand-700",
        config.box,
        className,
      )}
    >
      {initialsFrom(name)}
    </span>
  );
}
