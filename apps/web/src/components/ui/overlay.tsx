"use client";

import { useEffect, useId, useRef } from "react";

import { X } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Capas que tapan la página: diálogo en escritorio, hoja desde abajo en móvil.
 *
 * Es el mismo componente porque es la misma idea —algo que exige atención y se
 * cierra— y porque mantener dos habría significado mantener dos veces el
 * comportamiento que de verdad importa: cerrar con Escape, cerrar al pulsar
 * fuera, devolver el foco a donde estaba y no dejar que el fondo se desplace.
 *
 * Accesibilidad: `role="dialog"`, `aria-modal`, título anunciado, foco atrapado
 * dentro y devuelto al cerrar. Sin eso es una caja bonita que un lector de
 * pantalla atraviesa como si no existiera.
 */
export function Overlay({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  /** `sheet` sube desde abajo en móvil; en escritorio los dos son un diálogo. */
  variant = "dialog",
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  variant?: "dialog" | "sheet";
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;

    previousFocus.current = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    // El foco entra en el panel, no se queda detrás en la página tapada.
    const timer = window.setTimeout(() => {
      const focusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (focusable ?? panelRef.current)?.focus();
    }, 0);

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const items = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!items || items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(timer);
      document.body.style.overflow = overflow;
      previousFocus.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const sheet = variant === "sheet";

  return (
    <div
      className="fixed inset-0 z-(--z-index-overlay) flex animate-(--animate-fade-in) items-end justify-center sm:items-center"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Cerrar"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink-950/40 backdrop-blur-[2px]"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "relative flex max-h-[90dvh] w-full flex-col bg-surface shadow-[var(--shadow-overlay)] focus:outline-none",
          sheet
            ? "animate-(--animate-sheet-up) rounded-t-[var(--radius-card)] pb-[env(safe-area-inset-bottom)] sm:max-w-lg sm:animate-(--animate-slide-up) sm:rounded-[var(--radius-card)] sm:pb-0"
            : "animate-(--animate-slide-up) rounded-t-[var(--radius-card)] sm:max-w-lg sm:rounded-[var(--radius-card)]",
          className,
        )}
      >
        <div className="flex items-start gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-h3 text-ink-950">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-small text-ink-600">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="-mt-1 -mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-ink-500 hover:bg-ink-100 hover:text-ink-950"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">{children}</div>

        {footer && (
          <div className="border-t border-line px-5 py-4 sm:px-6">{footer}</div>
        )}
      </div>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
