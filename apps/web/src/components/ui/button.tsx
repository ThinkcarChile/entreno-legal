import Link from "next/link";

import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Botón y enlace con aspecto de botón.
 *
 * Una sola escala de variantes para toda la aplicación. `primary` es coral y es
 * el único relleno de marca: si en una pantalla hay dos botones coral, uno de
 * los dos está mintiendo sobre su importancia.
 *
 * `danger` es un rojo claramente más oscuro y menos rosado que el coral, porque
 * con una marca coral un destructivo del mismo tono se pulsa sin querer.
 *
 * Altura mínima de 44 px en los tamaños `md` y `lg`: es el área táctil que se
 * puede acertar de pie, con una mano y el teléfono en la otra, que es la
 * situación real de quien usa esto mientras trabaja.
 */
type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] font-medium " +
  "transition-colors duration-150 whitespace-nowrap " +
  "disabled:pointer-events-none disabled:opacity-50 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

const variants: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800",
  secondary: "bg-ink-950 text-white hover:bg-ink-800 active:bg-ink-900",
  outline: "border border-line-strong bg-surface text-ink-800 hover:bg-ink-50 active:bg-ink-100",
  ghost: "text-ink-700 hover:bg-ink-100 active:bg-ink-200",
  danger: "bg-danger-700 text-white hover:bg-danger-800 active:bg-danger-800",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-3.5 text-small",
  md: "h-11 px-5 text-[0.9375rem]",
  lg: "h-12 px-6 text-body sm:h-13",
};

interface Common {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, Common {
  /** Muestra un giro y bloquea el botón. Evita el doble envío. */
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  fullWidth,
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(base, variants[variant], sizes[size], fullWidth && "w-full", className)}
      {...props}
    >
      {loading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends React.ComponentProps<typeof Link>, Common {}

export function ButtonLink({
  variant = "primary",
  size = "md",
  fullWidth,
  className,
  children,
  ...props
}: ButtonLinkProps) {
  return (
    <Link
      className={cn(base, variants[variant], sizes[size], fullWidth && "w-full", className)}
      {...props}
    >
      {children}
    </Link>
  );
}

/** Botón redondo de solo icono. Siempre lleva `label`, que es su nombre accesible. */
export function IconButton({
  label,
  variant = "ghost",
  className,
  children,
  ...props
}: Omit<ButtonProps, "size" | "fullWidth"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        base,
        variants[variant],
        "h-11 w-11 rounded-[var(--radius-control)] p-0",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
