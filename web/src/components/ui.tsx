import Link from "next/link";

/**
 * Primitivas del kit NutriFamilia (Material 3). Existen para que cada pantalla
 * se escriba con el vocabulario del diseño —tarjeta, chip, sección— en vez de
 * repetir cadenas de clases que después se desincronizan entre sí.
 */

/** Icono Material Symbols. `filled` para el estado activo/seleccionado. */
export function Icon({
  name,
  filled = false,
  className = "",
}: {
  name: string;
  filled?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`material-symbols-outlined${filled ? " filled" : ""} ${className}`}
      aria-hidden
    >
      {name}
    </span>
  );
}

/** Tarjeta base: blanca, esquinas suaves, sombra verdosa del kit. */
export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "article" | "li" | "section";
}) {
  return (
    <Tag className={`soft-shadow rounded-3xl bg-surface-container-lowest ${className}`}>
      {children}
    </Tag>
  );
}

/** Tarjeta que navega. Mantiene el área de toque completa. */
export function CardLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`soft-shadow block rounded-3xl bg-surface-container-lowest transition-transform active:scale-[0.99] ${className}`}
    >
      {children}
    </Link>
  );
}

export type Tono = "neutro" | "primario" | "atencion" | "peligro" | "info";

const TONOS: Record<Tono, string> = {
  neutro: "bg-surface-container text-on-surface-variant",
  primario: "bg-primary-fixed text-on-primary-fixed",
  atencion: "bg-secondary-fixed text-on-secondary-fixed-variant",
  peligro: "bg-error-container text-on-error-container",
  info: "bg-tertiary-fixed text-on-tertiary-fixed-variant",
};

/**
 * Chip de estado. Lleva SIEMPRE texto: el color acompaña, nunca comunica solo
 * (accesibilidad §94 — nadie debe depender de distinguir verde de rojo).
 */
export function Chip({
  children,
  tono = "neutro",
  icon,
}: {
  children: React.ReactNode;
  tono?: Tono;
  icon?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-label-md text-label-md ${TONOS[tono]}`}
    >
      {icon && <Icon name={icon} className="text-[14px]" />}
      {children}
    </span>
  );
}

/** Título de sección con su acción opcional a la derecha. */
export function Section({
  title,
  hint,
  action,
  children,
  className = "",
}: {
  title?: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`mb-lg ${className}`}>
      {(title || action) && (
        <div className="mb-sm flex items-end justify-between gap-md">
          <div className="min-w-0">
            {title && (
              <h3 className="font-headline-sm text-headline-sm text-on-surface">{title}</h3>
            )}
            {hint && (
              <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">{hint}</p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Estado vacío. Distinto de un error a propósito: acá SÍ sabemos que no hay
 * nada; un error se muestra con `ErrorNote`.
 */
export function EmptyState({ icon, children }: { icon?: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col items-center gap-sm px-md py-lg text-center">
      {icon && <Icon name={icon} className="text-[32px] text-outline" />}
      <p className="font-body-sm text-body-sm text-on-surface-variant">{children}</p>
    </Card>
  );
}

/** Aviso de que algo FALLÓ (no de que esté vacío). */
export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-xl bg-error-container px-md py-sm font-body-sm text-body-sm text-on-error-container"
    >
      {children}
    </p>
  );
}

/** Nota de atención: algo que la persona debe mirar, sin ser un error. */
export function Notice({
  children,
  icon = "info",
  tono = "atencion",
}: {
  children: React.ReactNode;
  icon?: string;
  tono?: "atencion" | "info";
}) {
  const clase =
    tono === "atencion"
      ? "bg-secondary-fixed text-on-secondary-fixed-variant"
      : "bg-tertiary-fixed text-on-tertiary-fixed-variant";
  return (
    <div className={`flex items-start gap-sm rounded-2xl px-md py-sm ${clase}`}>
      <Icon name={icon} className="mt-0.5 shrink-0 text-[18px]" />
      <div className="min-w-0 font-body-sm text-body-sm">{children}</div>
    </div>
  );
}

/** Botón principal (relleno). */
export function Button({
  children,
  onClick,
  type = "button",
  disabled,
  className = "",
  full = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  full?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-sm rounded-full bg-primary px-lg py-sm font-body-md text-body-sm font-semibold text-on-primary transition-transform active:scale-95 disabled:opacity-40 ${full ? "w-full py-3" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

/** Botón secundario (contorno). */
export function ButtonOutline({
  children,
  onClick,
  type = "button",
  disabled,
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-sm rounded-full border border-outline px-lg py-sm font-body-md text-body-sm font-semibold text-on-surface-variant transition-transform active:scale-95 disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

/** Enlace con forma de botón (para navegación). */
export function LinkButton({
  href,
  children,
  variant = "filled",
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  variant?: "filled" | "outline";
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-sm rounded-full px-lg py-sm font-body-md text-body-sm font-semibold transition-transform active:scale-95";
  const estilo =
    variant === "filled"
      ? "bg-primary text-on-primary"
      : "border border-outline text-on-surface-variant";
  return (
    <Link href={href} className={`${base} ${estilo} ${className}`}>
      {children}
    </Link>
  );
}

/** Fila de dato: etiqueta a la izquierda, valor a la derecha. */
export function DataRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-md gap-y-1 border-b border-outline-variant/40 py-sm last:border-0">
      <span className="font-body-sm text-body-sm text-on-surface-variant">{label}</span>
      <span className="font-body-md text-body-md text-on-surface">{children}</span>
    </div>
  );
}
