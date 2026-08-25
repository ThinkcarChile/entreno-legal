"use client";

import Link from "next/link";
import { formatQuantity } from "@/domain/shopping/engine";
import type { StockItem } from "@/domain/stock/types";

/**
 * Bloques de Stock Intelligence (§30): qué usar pronto, qué está bajo, qué
 * reponer y qué está bien — con cada alimento respondiendo en una línea
 * "en casa / reservado / libre / cobertura".
 */

const CONFIDENCE_LABELS = { LOW: "baja", MEDIUM: "media", HIGH: "alta" } as const;

export function coverageText(item: StockItem): string {
  switch (item.coverage.kind) {
    case "DAYS":
      return `${item.coverage.days.toLocaleString("es-CL")} días`;
    case "INSUFFICIENT_DATA":
      return "sin datos suficientes";
    case "NO_EXPECTED_DEMAND":
      return "sin consumo esperado";
    case "UNRESOLVED":
      return "sin resolver";
  }
}

export function statusBadge(item: StockItem): { text: string; cls: string } {
  switch (item.reorder.status) {
    case "REORDER_NOW":
      return { text: "comprar ahora", cls: "bg-red-100 text-red-900" };
    case "REORDER_SOON":
      return { text: "comprar pronto", cls: "bg-amber-100 text-amber-900" };
    case "WATCH":
      return { text: "revisar", cls: "bg-amber-50 text-amber-800" };
    case "UNRESOLVED":
      return { text: "sin resolver", cls: "bg-[var(--ink)]/10 text-[var(--ink)]/70" };
    case "NO_ACTION":
      // §6 [U-1]: "bien" es un veredicto — sin cobertura calculada no se da.
      return item.coverage.kind === "DAYS"
        ? { text: "bien", cls: "bg-emerald-100 text-emerald-900" }
        : { text: "sin datos", cls: "bg-[var(--ink)]/10 text-[var(--ink)]/70" };
  }
}

export function StockOverview({ items }: { items: StockItem[] }) {
  if (items.length === 0) return null;

  const grupos: { titulo: string; filtro: (i: StockItem) => boolean; tono: string }[] = [
    {
      titulo: "Por reponer",
      filtro: (i) => i.reorder.status === "REORDER_NOW" || i.reorder.status === "REORDER_SOON",
      tono: "border-red-200 bg-red-50",
    },
    {
      titulo: "Stock bajo",
      filtro: (i) =>
        i.reorder.status === "WATCH" ||
        (i.target?.minimumQuantity != null && i.available < i.target.minimumQuantity),
      tono: "border-amber-200 bg-amber-50",
    },
    {
      titulo: "Bien abastecido",
      // Gate final §6 [U-1]: verde SOLO con cobertura CALCULADA. Un alimento
      // cuya cobertura el motor declara incalculable (INSUFFICIENT_DATA)
      // caía acá con badge "bien" — desconocido vestido de seguro.
      filtro: (i) => i.reorder.status === "NO_ACTION" && i.coverage.kind === "DAYS",
      tono: "border-emerald-200 bg-emerald-50",
    },
    {
      titulo: "Sin datos suficientes",
      filtro: (i) =>
        (i.reorder.status === "NO_ACTION" && i.coverage.kind !== "DAYS") ||
        i.reorder.status === "UNRESOLVED",
      tono: "border-[var(--ink)]/15 bg-[var(--ink)]/5",
    },
  ];

  const asignados = new Set<string>();

  return (
    <div className="space-y-3">
      {grupos.map((grupo) => {
        const propios = items.filter(
          (i) => !asignados.has(i.ingredientId + i.unit) && grupo.filtro(i),
        );
        propios.forEach((i) => asignados.add(i.ingredientId + i.unit));
        if (propios.length === 0) return null;
        return (
          <section key={grupo.titulo} className={`rounded-2xl border p-3 ${grupo.tono}`}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ink)]/60">
              {grupo.titulo}
            </h2>
            <ul className="space-y-1.5">
              {propios.map((item) => (
                <li key={item.ingredientId + item.unit}>
                  <Link
                    href={`/pantry/item/${item.ingredientId}?unit=${item.unit}`}
                    className="block rounded-xl bg-white/80 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-medium">
                        {item.hasApproximate && "~"}
                        {item.label}
                      </p>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${statusBadge(item).cls}`}
                      >
                        {statusBadge(item).text}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--ink)]/60">
                      En casa {formatQuantity(item.onHand, item.unit)}
                      {item.reserved > 0 && (
                        <> · reservado {formatQuantity(item.reserved, item.unit)}</>
                      )}
                      {" · "}libre{" "}
                      {item.available >= 0
                        ? formatQuantity(item.available, item.unit)
                        : `faltan ${formatQuantity(-item.available, item.unit)}`}
                      {" · "}
                      {coverageText(item)}
                    </p>
                    {item.reorder.recommendedQuantity !== null && (
                      <p className="mt-0.5 text-xs font-medium text-[var(--accent)]">
                        Comprar {formatQuantity(item.reorder.recommendedQuantity, item.unit)}
                        {item.confidence && <> · confianza {CONFIDENCE_LABELS[item.confidence]}</>}
                      </p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
