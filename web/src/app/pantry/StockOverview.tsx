"use client";

import { formatQuantity } from "@/domain/shopping/engine";
import type { StockItem } from "@/domain/stock/types";
import { CardLink, Chip, Icon, Section, type Tono } from "@/components/ui";

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

export function statusBadge(item: StockItem): { text: string; tono: Tono } {
  switch (item.reorder.status) {
    case "REORDER_NOW":
      return { text: "comprar ahora", tono: "peligro" };
    case "REORDER_SOON":
      return { text: "comprar pronto", tono: "atencion" };
    case "WATCH":
      return { text: "revisar", tono: "atencion" };
    case "UNRESOLVED":
      return { text: "sin resolver", tono: "neutro" };
    case "NO_ACTION":
      // §6 [U-1]: "bien" es un veredicto — sin cobertura calculada no se da.
      return item.coverage.kind === "DAYS"
        ? { text: "bien", tono: "primario" }
        : { text: "sin datos", tono: "neutro" };
  }
}

/** Paleta del bloque de resumen, por grupo. Solo tokens del kit. */
const TILE: Record<Tono, string> = {
  peligro: "bg-error-container text-on-error-container",
  atencion: "bg-secondary-fixed text-on-secondary-fixed-variant",
  primario: "bg-primary-fixed text-on-primary-fixed",
  info: "bg-tertiary-fixed text-on-tertiary-fixed-variant",
  neutro: "bg-surface-container text-on-surface-variant",
};

export function StockOverview({ items }: { items: StockItem[] }) {
  if (items.length === 0) return null;

  const grupos: { titulo: string; icon: string; tono: Tono; filtro: (i: StockItem) => boolean }[] = [
    {
      titulo: "Por reponer",
      icon: "shopping_cart",
      tono: "peligro",
      filtro: (i) => i.reorder.status === "REORDER_NOW" || i.reorder.status === "REORDER_SOON",
    },
    {
      titulo: "Stock bajo",
      icon: "warning",
      tono: "atencion",
      filtro: (i) =>
        i.reorder.status === "WATCH" ||
        (i.target?.minimumQuantity != null && i.available < i.target.minimumQuantity),
    },
    {
      titulo: "Bien abastecido",
      icon: "check_circle",
      tono: "primario",
      // Gate final §6 [U-1]: verde SOLO con cobertura CALCULADA. Un alimento
      // cuya cobertura el motor declara incalculable (INSUFFICIENT_DATA)
      // caía acá con badge "bien" — desconocido vestido de seguro.
      filtro: (i) => i.reorder.status === "NO_ACTION" && i.coverage.kind === "DAYS",
    },
    {
      titulo: "Sin datos suficientes",
      icon: "help",
      tono: "neutro",
      filtro: (i) =>
        (i.reorder.status === "NO_ACTION" && i.coverage.kind !== "DAYS") ||
        i.reorder.status === "UNRESOLVED",
    },
  ];

  const asignados = new Set<string>();
  // Un solo reparto: cada alimento cae en el primer grupo que lo reclama, y el
  // resumen de arriba cuenta exactamente lo que se lista abajo.
  const repartidos = grupos.map((grupo) => {
    const propios = items.filter((i) => !asignados.has(i.ingredientId + i.unit) && grupo.filtro(i));
    propios.forEach((i) => asignados.add(i.ingredientId + i.unit));
    return { grupo, propios };
  });

  return (
    <div>
      <div className="hide-scrollbar -mx-container-margin mb-lg flex snap-x snap-mandatory gap-md overflow-x-auto px-container-margin md:mx-0 md:px-0">
        {repartidos
          .filter(({ propios }) => propios.length > 0)
          .map(({ grupo, propios }) => (
            <div
              key={grupo.titulo}
              className={`soft-shadow flex w-36 shrink-0 snap-start flex-col justify-between rounded-xl p-md ${TILE[grupo.tono]}`}
            >
              <span className="font-label-md text-label-md uppercase">{grupo.titulo}</span>
              <span className="mt-sm font-headline-xl text-headline-xl">{propios.length}</span>
            </div>
          ))}
      </div>

      {repartidos.map(({ grupo, propios }) =>
        propios.length === 0 ? null : (
          <Section
            key={grupo.titulo}
            title={grupo.titulo}
            action={<Chip tono={grupo.tono}>{propios.length}</Chip>}
          >
            <ul className="space-y-sm">
              {propios.map((item) => (
                <li key={item.ingredientId + item.unit}>
                  <CardLink
                    href={`/pantry/item/${item.ingredientId}?unit=${item.unit}`}
                    className="flex items-start gap-md p-md"
                  >
                    <span
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TILE[grupo.tono]}`}
                    >
                      <Icon name={grupo.icon} filled />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start justify-between gap-sm">
                        <span className="min-w-0 truncate font-body-md text-body-md font-semibold text-on-surface">
                          {item.hasApproximate && "~"}
                          {item.label}
                        </span>
                        <Chip tono={statusBadge(item).tono}>{statusBadge(item).text}</Chip>
                      </span>
                      <span className="mt-0.5 block font-body-sm text-body-sm text-on-surface-variant">
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
                      </span>
                      {item.reorder.recommendedQuantity !== null && (
                        <span className="mt-0.5 block font-body-sm text-body-sm font-semibold text-primary">
                          Comprar {formatQuantity(item.reorder.recommendedQuantity, item.unit)}
                          {item.confidence && (
                            <> · confianza {CONFIDENCE_LABELS[item.confidence]}</>
                          )}
                        </span>
                      )}
                    </span>
                  </CardLink>
                </li>
              ))}
            </ul>
          </Section>
        ),
      )}
    </div>
  );
}
