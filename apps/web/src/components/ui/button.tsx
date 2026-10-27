import Link from "next/link";

import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Botón y enlace con aspecto de botón.
 *
 * Una sola escala de variantes para toda la aplicación. `primary` es el verde
 * petróleo y hay uno por bloque de decisión: si en una pantalla hay dos botones
 * principales juntos, uno de los dos está mintiendo sobre su importancia.
 *
 * `accent` es el lima, para la acción destacada de una portada o sobre fondo
 * oscuro; no reemplaza a `primary` en formularios. `secondary` es el relleno
 * suave para la acción que acompaña. `danger` lleva texto blanco sobre rojo
 * oscuro: un destructivo no se puede confundir con el botón principal.
 *
 * Altura mínima de 44 px en los tamaños `md` y `lg`: es el área táctil que se
 * puede acertar de pie, con una mano y el teléfono en la otra, que es la
 * situación real de quien usa esto mientras trabaja.
 */
type Variant = "primary" | "accent" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] font-bold " +
  "transition-[color,background-color,border-color,transform] duration-150 whitespace-nowrap " +
  "motion-safe:active:scale-[0.98] " +
  "disabled:pointer-events-none disabled:opacity-50 " +
  "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand-700";

const variants: Record<Variant, string> = {
  primary: "bg-brand-950 text-white hover:bg-brand-900 active:bg-brand-800",
  accent: "bg-accent-300 text-brand-950 hover:bg-accent-400 active:bg-accent-500",
  secondary: "bg-brand-50 text-brand-950 hover:bg-brand-100 active:bg-brand-200",
  outline:
    "border border-brand-200 bg-surface text-brand-950 hover:border-brand-300 hover:bg-brand-50 active:bg-brand-100",
  ghost: "text-brand-700 hover:bg-brand-50 active:bg-brand-100",
  danger: "bg-danger-700 text-white hover:bg-danger-800 active:bg-danger-800",
};

const sizes: Record<Size, string> = {
  sm: "h-9 rounded-[var(--radius-chip)] px-3.5 text-small",
  md: "h-11.5 px-5 text-[0.9375rem]",
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
