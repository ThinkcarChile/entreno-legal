import Link from "next/link";

import {
  Building2,
  Clock,
  FileText,
  ListChecks,
  Moon,
  Package,
  ShoppingBag,
  Ticket,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";

import { AmountRange, Section } from "@/components/ui";
import { CategoryGroup } from "@/lib/domain/enums";

import type { JobCategory } from "@/lib/domain/types";

const icons: Record<string, LucideIcon> = {
  ticket: Ticket,
  "shopping-bag": ShoppingBag,
  utensils: UtensilsCrossed,
  building: Building2,
  moon: Moon,
  "file-text": FileText,
  package: Package,
  clock: Clock,
  "list-checks": ListChecks,
};

export function Categories({
  categories,
  counts,
}: {
  categories: readonly JobCategory[];
  counts: Readonly<Record<string, number>>;
}) {
  const filas = categories.filter((c) => c.group === CategoryGroup.FILA);
  const tramites = categories.filter((c) => c.group === CategoryGroup.TRAMITE);

  return (
    <Section
      eyebrow="Categorías"
      title="¿Qué necesitas delegar?"
      description="Dos grandes familias de servicios, siempre dentro de lo que la ley y cada establecimiento permiten."
    >
      <div className="space-y-10">
        <CategoryGroupBlock title="Hacer una fila" categories={filas} counts={counts} />
        <CategoryGroupBlock title="Trámites y gestiones" categories={tramites} counts={counts} />
      </div>
    </Section>
  );
}

function CategoryGroupBlock({
  title,
  categories,
  counts,
}: {
  title: string;
  categories: readonly JobCategory[];
  counts: Readonly<Record<string, number>>;
}) {
  return (
    <div>
      <h3 className="text-label text-ink-500 uppercase">{title}</h3>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((category) => {
          const Icon = icons[category.icon ?? ""] ?? ListChecks;
          const count = counts[category.id] ?? 0;

          return (
            <li key={category.id}>
              <Link
                href={`/trabajos?categoria=${category.slug}`}
                className="flex h-full gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5 transition-colors hover:border-brand-200 hover:bg-brand-50/40"
              >
                <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-brand-50 text-brand-700">
                  <Icon size={20} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold text-ink-950">{category.name}</span>
                  {category.description && (
                    <span className="mt-1 block text-small text-ink-600">{category.description}</span>
                  )}
                  <span className="mt-2 block text-caption text-ink-500">
                    Referencia{" "}
                    <AmountRange
                      min={category.baseHourlyMin}
                      max={category.baseHourlyMax}
                      className="font-medium text-ink-700"
                    />{" "}
                    por hora
                    {count > 0 && ` · ${count} abiertos`}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
