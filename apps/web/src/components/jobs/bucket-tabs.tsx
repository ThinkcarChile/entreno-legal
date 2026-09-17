"use client";

import { useState } from "react";

import { cn } from "@/lib/utils/cn";

/**
 * Pestañas de "mis trabajos".
 *
 * En móvil se desplazan horizontalmente en vez de apilarse: ocupan una línea y
 * dejan el contenido arriba, que es lo que se viene a mirar.
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

  const current = buckets.find((b) => b.id === active) ?? buckets[0];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Estados"
        className="-mx-5 flex gap-1.5 overflow-x-auto px-5 pb-1 sm:mx-0 sm:px-0"
      >
        {buckets.map((bucket) => (
          <button
            key={bucket.id}
            role="tab"
            aria-selected={bucket.id === active}
            onClick={() => setActive(bucket.id)}
            className={cn(
              "shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
              bucket.id === active
                ? "border-brand-600 bg-brand-600 text-white"
                : "border-ink-200 bg-white text-ink-700 hover:border-brand-300",
            )}
          >
            {bucket.label}
            {bucket.items.length > 0 && (
              <span className={cn("ml-1.5 tabular-nums", bucket.id === active ? "text-brand-100" : "text-ink-400")}>
                {bucket.items.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="mt-6">
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
