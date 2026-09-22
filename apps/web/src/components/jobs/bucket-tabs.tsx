"use client";

import { useId, useRef, useState } from "react";

import { cn } from "@/lib/utils/cn";

/**
 * Pestañas de "mis trabajos".
 *
 * En móvil se desplazan horizontalmente en vez de apilarse: ocupan una línea y
 * dejan el contenido arriba, que es lo que se viene a mirar. Desde `lg` hay
 * sitio de sobra, así que se reparten en varias líneas: una fila recortada en
 * una pantalla ancha esconde estados sin que nadie sepa que están ahí.
 *
 * Teclado: flechas para moverse entre pestañas, Inicio y Fin para los extremos,
 * y solo la activa entra en el orden de tabulación. Es lo que espera un lector
 * de pantalla de algo que se anuncia como `tablist`.
 *
 * Recibe el contenido ya construido, no funciones que lo construyan. Este
 * componente corre en el navegador y las dos páginas que lo usan son de
 * servidor: una función no cruza esa frontera —React no sabe serializarla— y la
 * página fallaba con «Functions cannot be passed directly to Client
 * Components» en cuanto había al menos un trabajo que mostrar. Con la cuenta
 * vacía no se llegaba a renderizar, que es por lo que había pasado inadvertido.
 * Un elemento de React sí viaja.
 */
export interface BucketPanel {
  id: string;
  label: string;
  items: readonly React.ReactNode[];
  empty: React.ReactNode;
}

export function BucketTabs({ buckets }: { buckets: readonly BucketPanel[] }) {
  const firstWithItems = buckets.find((b) => b.items.length > 0) ?? buckets[0];
  const [active, setActive] = useState(firstWithItems?.id ?? "");
  const ids = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const current = buckets.find((b) => b.id === active) ?? buckets[0];

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = buckets.findIndex((b) => b.id === active);
    if (index < 0) return;

    const target =
      event.key === "ArrowRight"
        ? (index + 1) % buckets.length
        : event.key === "ArrowLeft"
          ? (index - 1 + buckets.length) % buckets.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buckets.length - 1
              : null;
    if (target === null) return;

    event.preventDefault();
    const next = buckets[target];
    if (!next) return;
    setActive(next.id);
    tabs.current[target]?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Estados"
        onKeyDown={onKeyDown}
        className="-mx-5 flex gap-1.5 overflow-x-auto px-5 pb-1 sm:mx-0 sm:px-0 lg:flex-wrap lg:overflow-visible"
      >
        {buckets.map((bucket, index) => {
          const selected = bucket.id === active;
          return (
            <button
              key={bucket.id}
              ref={(node) => void (tabs.current[index] = node)}
              id={`${ids}-tab-${bucket.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${ids}-panel-${bucket.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(bucket.id)}
              className={cn(
                "shrink-0 rounded-[var(--radius-pill)] border px-3.5 py-1.5 text-small font-medium transition-colors",
                selected
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-line bg-surface text-ink-700 hover:border-brand-300",
              )}
            >
              {bucket.label}
              {bucket.items.length > 0 && (
                <span
                  className={cn(
                    "ml-1.5 tabular-nums",
                    selected ? "text-brand-100" : "text-ink-500",
                  )}
                >
                  {bucket.items.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={current ? `${ids}-panel-${current.id}` : undefined}
        aria-labelledby={current ? `${ids}-tab-${current.id}` : undefined}
        tabIndex={0}
        className="mt-6"
      >
        {current && current.items.length > 0 ? (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {current.items.map((item, index) => (
              <li key={index} className="relative flex">
                {item}
              </li>
            ))}
          </ul>
        ) : (
          current && current.empty
        )}
      </div>
    </div>
  );
}
