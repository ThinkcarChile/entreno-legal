"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Search } from "lucide-react";

import { Button, Select } from "@/components/ui";
import { regions } from "@/lib/geo/chile";

import type { JobCategory } from "@/lib/domain/types";

/**
 * Buscador de la portada.
 *
 * Es un formulario de verdad, con `method="get"` hacia `/trabajos`: sin
 * JavaScript navega igual, y con JavaScript se queda con la transición del
 * enrutador y con la limpieza de los campos vacíos, para no dejar
 * `?categoria=&comuna=` colgando en una URL que la gente comparte.
 *
 * Las comunas van agrupadas por región en un `optgroup`: son más de trescientas
 * y una lista plana obliga a saber de memoria dónde cae cada una.
 */
export function HomeSearch({ categories }: { categories: readonly JobCategory[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const ids = useId();
  // La fecha mínima es hoy: no se puede pedir una fila para ayer.
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const key of ["categoria", "comuna", "desde"]) {
      const value = form.get(key);
      if (typeof value === "string" && value) params.set(key, value);
    }
    const query = params.toString();
    startTransition(() => router.push(query ? `/trabajos?${query}` : "/trabajos"));
  }

  return (
    <form
      action="/trabajos"
      method="get"
      onSubmit={onSubmit}
      className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-raised)] sm:p-5"
    >
      <p className="text-label text-ink-500 uppercase">Busca un trabajo publicado</p>

      <div className="mt-3 grid gap-3 md:grid-cols-[1.1fr_1.1fr_0.9fr_auto] md:items-end">
        <div className="space-y-1.5">
          <label htmlFor={`${ids}-categoria`} className="block text-small font-medium text-ink-800">
            Categoría
          </label>
          <Select id={`${ids}-categoria`} name="categoria" defaultValue="">
            <option value="">Todas las categorías</option>
            {categories.map((category) => (
              <option key={category.id} value={category.slug}>
                {category.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={`${ids}-comuna`} className="block text-small font-medium text-ink-800">
            Comuna
          </label>
          <Select id={`${ids}-comuna`} name="comuna" defaultValue="">
            <option value="">Todo Chile</option>
            {regions.map((region) => (
              <optgroup key={region.code} label={region.shortName}>
                {region.communes.map((commune) => (
                  <option key={commune.code} value={commune.code}>
                    {commune.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={`${ids}-desde`} className="block text-small font-medium text-ink-800">
            Desde
          </label>
          <input
            id={`${ids}-desde`}
            name="desde"
            type="date"
            min={today}
            className="h-11 w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3.5 text-body text-ink-950 transition-colors focus:border-brand-500 focus:ring-4 focus:ring-brand-100 focus:outline-none"
          />
        </div>

        <Button type="submit" size="lg" loading={pending} className="md:w-auto">
          <Search size={17} aria-hidden="true" />
          Buscar
        </Button>
      </div>
    </form>
  );
}
