"use client";

import { useId, useRef, useState } from "react";

import { cn } from "@/lib/utils/cn";

/**
 * Pestañas y control segmentado.
 *
 * Con el patrón de teclado que la gente espera de unas pestañas: flechas para
 * moverse, Inicio y Fin para los extremos. Sin eso son botones con aspecto de
 * pestaña, y un lector de pantalla los anuncia como lo que no son.
 *
 * En móvil la fila se desplaza en horizontal en vez de partirse en dos líneas:
 * seis estados de un trabajo no caben en 360 px, y apilarlos empuja el
 * contenido fuera de la pantalla.
 */

export interface TabItem {
  id: string;
  label: string;
  /** Número al lado de la etiqueta, cuando decir «cuántos» ayuda a elegir. */
  count?: number;
  content: React.ReactNode;
}

export function Tabs({
  items,
  initialId,
  className,
  label = "Secciones",
}: {
  items: readonly TabItem[];
  initialId?: string;
  className?: string;
  label?: string;
}) {
  const baseId = useId();
  const [active, setActive] = useState(initialId ?? items[0]?.id);
  const listRef = useRef<HTMLDivElement>(null);

  if (items.length === 0) return null;

  function move(delta: number) {
    const index = items.findIndex((item) => item.id === active);
    const next = items[(index + delta + items.length) % items.length];
    setActive(next.id);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${baseId}-tab-${next.id}`)}`)
      ?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        move(1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        event.preventDefault();
        setActive(items[0].id);
        break;
      case "End":
        event.preventDefault();
        setActive(items[items.length - 1].id);
        break;
    }
  }

  const current = items.find((item) => item.id === active) ?? items[0];

  return (
    <div className={className}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="scroll-row -mx-1 gap-1 border-b border-line px-1"
      >
        {items.map((item) => {
          const selected = item.id === current.id;
          return (
            <button
              key={item.id}
              id={`${baseId}-tab-${item.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(item.id)}
              className={cn(
                "relative shrink-0 rounded-t-[var(--radius-control)] px-3.5 py-2.5 text-small font-medium whitespace-nowrap transition-colors",
                selected
                  ? "text-brand-700 after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-brand-600"
                  : "text-ink-500 hover:text-ink-800",
              )}
            >
              {item.label}
              {item.count != null && (
                <span
                  className={cn(
                    "ml-1.5 rounded-full px-1.5 py-0.5 text-[0.6875rem] tabular-nums",
                    selected ? "bg-brand-50 text-brand-700" : "bg-ink-100 text-ink-600",
                  )}
                >
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        id={`${baseId}-panel-${current.id}`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${current.id}`}
        tabIndex={0}
        className="pt-5 focus:outline-none"
      >
        {current.content}
      </div>
    </div>
  );
}

/** Dos o tres opciones excluyentes, como un interruptor de tres posiciones. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex rounded-[var(--radius-pill)] bg-ink-100 p-1", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-[var(--radius-pill)] px-3.5 py-1.5 text-small font-medium transition-colors",
              selected ? "bg-surface text-ink-950 shadow-sm" : "text-ink-600 hover:text-ink-950",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
