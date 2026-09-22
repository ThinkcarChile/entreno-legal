import { AlertTriangle, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Estado de error de una sección.
 *
 * Distinto del estado vacío: vacío significa «todavía no hay nada», error
 * significa «hay algo y no pudimos traerlo». Confundirlos hace que alguien
 * publique un trabajo que ya tenía publicado.
 */
export function ErrorState({
  title = "No pudimos cargar esta parte",
  description = "Vuelve a intentarlo en un momento. Si sigue igual, escríbenos.",
  action,
  className,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "rounded-[var(--radius-card)] border border-danger-100 bg-danger-50/60 px-6 py-10 text-center",
        className,
      )}
    >
      <AlertTriangle size={22} className="mx-auto text-danger-600" aria-hidden="true" />
      <p className="mt-3 font-medium text-ink-950">{title}</p>
      <p className="mt-1 text-small text-ink-600">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Bloque de confianza: un icono, un titular y una frase.
 *
 * Aparece en la portada, en el pago y en la ayuda. Se comparte para que las
 * tres digan lo mismo con las mismas palabras.
 */
export function TrustItem({
  icon: Icon,
  title,
  children,
  tone = "brand",
  className,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
  tone?: "brand" | "success" | "ink";
  className?: string;
}) {
  const tones = {
    brand: "bg-brand-50 text-brand-600",
    success: "bg-success-50 text-success-600",
    ink: "bg-ink-100 text-ink-700",
  } as const;

  return (
    <div className={cn("flex gap-3.5", className)}>
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)]",
          tones[tone],
        )}
      >
        <Icon size={20} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="font-medium text-ink-950">{title}</p>
        <p className="mt-0.5 text-small text-ink-600">{children}</p>
      </div>
    </div>
  );
}
