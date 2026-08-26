"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatQuantity } from "@/domain/shopping/engine";
import type { StockItem } from "@/domain/stock/types";
import { addReorderToShoppingList } from "@/app/stock/actions";
import { Card, Chip, EmptyState, Flotante, Icon, type Tono } from "@/components/ui";
import { coverageText, statusBadge } from "../StockOverview";

const CONFIDENCE_LABELS = { LOW: "baja", MEDIUM: "media", HIGH: "alta" } as const;

/** Los tres niveles de urgencia que el motor ya distingue, cada uno con su piel. */
const NIVELES: {
  status: StockItem["reorder"]["status"];
  titulo: string;
  hint: string;
  icon: string;
  tono: Tono;
  marco: string;
}[] = [
  {
    status: "REORDER_NOW",
    titulo: "Comprar ahora",
    hint: "No alcanza",
    icon: "error",
    tono: "peligro",
    marco: "bg-error-container text-on-error-container",
  },
  {
    status: "REORDER_SOON",
    titulo: "Comprar pronto",
    hint: "Se acaba en días",
    icon: "warning",
    tono: "atencion",
    marco: "bg-secondary-fixed text-on-secondary-fixed-variant",
  },
  {
    status: "WATCH",
    titulo: "Vigilar",
    hint: "Suficiente por ahora",
    icon: "visibility",
    tono: "primario",
    marco: "bg-primary-fixed text-on-primary-fixed",
  },
];


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
      <div className="mt-md">
        <EmptyState icon="inventory_2">
          Todo bien abastecido según lo que sabemos. Las recomendaciones aparecen acá cuando el
          stock libre no alcanza para el plan o tu consumo habitual.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="mt-md">
      {message && <Flotante tono="ok">{message}</Flotante>}
      {error && <Flotante tono="error">{error}</Flotante>}

      {NIVELES.map((nivel) => {
        // El orden dentro del nivel es el del motor: no se reordena acá.
        const propios = items.filter((i) => i.reorder.status === nivel.status);
        if (propios.length === 0) return null;
        return (
          <section key={nivel.status} className="mb-xl">
            <div className="mb-md flex items-center gap-sm">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${nivel.marco}`}
              >
                <Icon name={nivel.icon} className="text-[16px]" />
              </span>
              <h3 className="font-headline-sm text-headline-sm text-on-surface">{nivel.titulo}</h3>
              <span className="ml-auto shrink-0 font-label-md text-label-md text-on-surface-variant">
                {nivel.hint}
              </span>
            </div>

            <ul className="grid grid-cols-1 gap-md md:grid-cols-2">
              {propios.map((item) => (
                <li key={item.ingredientId + item.unit}>
                  <Card as="article" className="flex h-full flex-col gap-sm p-md">
                    <div className="flex items-start justify-between gap-sm">
                      <Link
                        href={`/pantry/item/${item.ingredientId}?unit=${item.unit}`}
                        className="min-w-0 truncate font-body-lg text-body-lg font-semibold text-on-surface underline-offset-2 hover:underline"
                      >
                        {item.label}
                      </Link>
                      <Chip tono={statusBadge(item).tono}>{statusBadge(item).text}</Chip>
                    </div>

                    {item.reorder.recommendedQuantity !== null && (
                      <p className="font-headline-sm text-headline-sm text-primary">
                        Comprar {formatQuantity(item.reorder.recommendedQuantity, item.unit)}
                        <span className="ml-1 font-body-sm text-body-sm font-normal text-on-surface-variant">
                          (horizonte {item.reorder.horizonDays} días)
                        </span>
                      </p>
                    )}

                    <p className="font-body-sm text-body-sm text-on-surface-variant">
                      Libre{" "}
                      {item.available >= 0
                        ? formatQuantity(item.available, item.unit)
                        : `−${formatQuantity(-item.available, item.unit)}`}{" "}
                      · cobertura {coverageText(item)}
                      {item.confidence && <> · confianza {CONFIDENCE_LABELS[item.confidence]}</>}
                    </p>

                    <details>
                      <summary className="cursor-pointer font-body-sm text-body-sm font-semibold text-primary">
                        ¿Por qué?
                      </summary>
                      <ul className="mt-sm list-inside list-disc space-y-1 font-body-sm text-body-sm text-on-surface-variant">
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
                        className="mt-auto inline-flex items-center justify-center gap-sm rounded-full bg-secondary px-lg py-sm font-body-md text-body-sm font-semibold text-on-secondary transition-transform active:scale-95 disabled:opacity-40"
                      >
                        <Icon
                          name={
                            agregados.has(claveDe(item)) ? "check_circle" : "add_shopping_cart"
                          }
                          className="text-[18px]"
                        />
                        {agregados.has(claveDe(item))
                          ? "Agregado a la próxima compra"
                          : "Agregar a próxima compra"}
                      </button>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
