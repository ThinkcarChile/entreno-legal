"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatQuantity } from "@/domain/shopping/engine";
import type { StockItem } from "@/domain/stock/types";
import { addReorderToShoppingList } from "@/app/stock/actions";
import { coverageText, statusBadge } from "../StockOverview";

const CONFIDENCE_LABELS = { LOW: "baja", MEDIUM: "media", HIGH: "alta" } as const;

export function ReorderBoard({
  items,
  weekStart,
  yaSugeridos,
}: {
  items: StockItem[];
  weekStart: string;
  /** Alimentos que YA tienen sugerencia pendiente en la lista de la semana. */
  yaSugeridos: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agregados, setAgregados] = useState<Set<string>>(new Set(yaSugeridos));

  // La clave de "ya sugerido" usa la base DE COMPRA: un bucket COCIDO se
  // compra convertido a crudo, así que su línea en la lista es RAW.
  function claveDe(item: StockItem): string {
    return item.ingredientId + item.unit + (item.weightBasis === "DRAINED" ? "DRAINED" : "RAW");
  }

  function agregar(item: StockItem) {
    if (item.reorder.recommendedQuantity === null) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await addReorderToShoppingList({
        weekStart,
        ingredientId: item.ingredientId,
        label: item.label,
        quantity: item.reorder.recommendedQuantity!,
        unit: item.unit,
        weightBasis: item.weightBasis,
      });
      if (!r.ok) {
        setError(r.error ?? "No se pudo agregar.");
        return;
      }
      setMessage(r.message ?? "Agregado.");
      // Gate 0→10 [M-3]: el botón dice "Agregado" SOLO si se escribió una
      // línea. "Ya estaba cubierto" es información, no una línea nueva.
      if (r.added) {
        setAgregados((prev) => new Set([...prev, claveDe(item)]));
      }
      router.refresh();
    });
  }

  if (items.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-[var(--ink)]/20 bg-white p-6 text-center text-sm text-[var(--ink)]/60">
        Todo bien abastecido según lo que sabemos. Las recomendaciones aparecen acá cuando el
        stock libre no alcanza para el plan o tu consumo habitual.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {message && (
        <p className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-3xl rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm text-white shadow-lg">
          {message}
        </p>
      )}
      {error && (
        <p
          className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-3xl rounded-xl bg-red-600 px-4 py-2.5 text-sm text-white shadow-lg"
          role="alert"
        >
          {error}
        </p>
      )}

      {items.map((item) => (
        <section
          key={item.ingredientId + item.unit}
          className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <Link
              href={`/pantry/item/${item.ingredientId}?unit=${item.unit}`}
              className="min-w-0 truncate text-sm font-semibold underline-offset-2 hover:underline"
            >
              {item.label}
            </Link>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${statusBadge(item).cls}`}>
              {statusBadge(item).text}
            </span>
          </div>

          <p className="mt-1 text-xs text-[var(--ink)]/60">
            Libre{" "}
            {item.available >= 0
              ? formatQuantity(item.available, item.unit)
              : `−${formatQuantity(-item.available, item.unit)}`}{" "}
            · cobertura {coverageText(item)}
            {item.confidence && <> · confianza {CONFIDENCE_LABELS[item.confidence]}</>}
          </p>

          {item.reorder.recommendedQuantity !== null && (
            <p className="mt-1 text-sm font-medium text-[var(--accent)]">
              Comprar {formatQuantity(item.reorder.recommendedQuantity, item.unit)}
              <span className="ml-1 text-xs font-normal text-[var(--ink)]/40">
                (horizonte {item.reorder.horizonDays} días)
              </span>
            </p>
          )}

          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-[var(--accent)]">¿Por qué?</summary>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-[var(--ink)]/70">
              {item.reorder.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </details>

          {item.reorder.recommendedQuantity !== null && (
            <button
              type="button"
              disabled={pending || agregados.has(claveDe(item))}
              onClick={() => agregar(item)}
              className="mt-2 rounded-full border border-[var(--accent)] px-4 py-1.5 text-xs font-medium text-[var(--accent)] disabled:opacity-50"
            >
              {agregados.has(claveDe(item))
                ? "Agregado a la próxima compra"
                : "Agregar a próxima compra"}
            </button>
          )}
        </section>
      ))}
    </div>
  );
}
