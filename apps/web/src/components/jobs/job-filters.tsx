"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { Search, SlidersHorizontal, X } from "lucide-react";

import { Button, Input, Select } from "@/components/ui";
import { CategoryGroup } from "@/lib/domain/enums";
import { regions } from "@/lib/geo/chile";
import { cn } from "@/lib/utils/cn";

import type { JobCategory } from "@/lib/domain/types";

/**
 * Filtros del listado.
 *
 * El estado vive en la URL: los resultados son compartibles, indexables y el
 * botón «atrás» del navegador funciona como el usuario espera.
 *
 * Dos decisiones que se ven poco y se notan mucho:
 *
 * · Lo habitual —buscar, tipo, categoría, dónde y orden— está siempre a la
 *   vista; lo que se usa una vez de cada veinte —fechas, pago mínimo, duración,
 *   madrugada, bono— vive detrás de «Más filtros». Antes eran trece controles
 *   sueltos en fila, que en un teléfono son tres pantallas de desplazamiento
 *   antes de ver un solo trabajo.
 *
 * · El campo de texto espera a que dejes de escribir. Antes navegaba en cada
 *   pulsación: escribir «notaría» eran siete navegaciones y siete consultas,
 *   y el cursor saltaba al final a media palabra.
 */
const DEBOUNCE_MS = 350;

export function JobFilters({ categories }: { categories: readonly JobCategory[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const timer = useRef<number | null>(null);

  const push = useCallback(
    (next: URLSearchParams) => {
      next.delete("pagina");
      const query = next.toString();
      startTransition(() => router.push(query ? `/trabajos?${query}` : "/trabajos"));
    },
    [router],
  );

  const update = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      // Cambiar de región invalida la comuna elegida en la anterior.
      if (key === "region") next.delete("comuna");
      push(next);
    },
    [params, push],
  );

  const updateDebounced = useCallback(
    (key: string, value: string) => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => update(key, value), DEBOUNCE_MS);
    },
    [update],
  );

  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

  const selectedRegion = params.get("region") ?? "";
  const communes = regions.find((r) => r.code === selectedRegion)?.communes ?? [];

  const active = [...params.entries()].filter(([key]) => key !== "pagina" && key !== "orden");
  const extraKeys = ["desde", "hasta", "pagoMin", "duracionMax", "overnight", "bono"];
  const extraCount = extraKeys.filter((key) => params.get(key)).length;

  // Los filtros avanzados quedan abiertos si ya se está usando alguno: si no,
  // se aplican filtros invisibles y los resultados parecen equivocados.
  const [showMore, setShowMore] = useState(extraCount > 0);

  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] border border-line bg-surface p-4 transition-opacity sm:p-5",
        pending && "opacity-70",
      )}
      data-pending={pending ? "" : undefined}
    >
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div className="relative lg:col-span-2">
          <Search
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-500"
          />
          <Input
            type="search"
            placeholder="Buscar por título o comuna"
            aria-label="Buscar trabajos"
            defaultValue={params.get("q") ?? ""}
            className="pl-10"
            onChange={(event) => updateDebounced("q", event.target.value)}
          />
        </div>

        <Select
          aria-label="Tipo de servicio"
          value={params.get("tipo") ?? ""}
          onChange={(event) => update("tipo", event.target.value)}
        >
          <option value="">Todos los tipos</option>
          <option value={CategoryGroup.FILA}>Hacer una fila</option>
          <option value={CategoryGroup.TRAMITE}>Trámites y gestiones</option>
        </Select>

        <Select
          aria-label="Categoría"
          value={params.get("categoria") ?? ""}
          onChange={(event) => update("categoria", event.target.value)}
        >
          <option value="">Todas las categorías</option>
          {categories.map((category) => (
            <option key={category.id} value={category.slug}>
              {category.name}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Región"
          value={selectedRegion}
          onChange={(event) => update("region", event.target.value)}
        >
          <option value="">Todo Chile</option>
          {regions.map((region) => (
            <option key={region.code} value={region.code}>
              {region.shortName}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Comuna"
          value={params.get("comuna") ?? ""}
          disabled={communes.length === 0}
          onChange={(event) => update("comuna", event.target.value)}
        >
          <option value="">
            {communes.length === 0 ? "Elige una región primero" : "Todas las comunas"}
          </option>
          {communes.map((commune) => (
            <option key={commune.code} value={commune.code}>
              {commune.name}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Ordenar resultados"
          value={params.get("orden") ?? "recent"}
          onChange={(event) => update("orden", event.target.value)}
        >
          <option value="recent">Más recientes</option>
          <option value="starts_soon">Comienzan antes</option>
          <option value="budget_desc">Mejor pago</option>
          <option value="budget_asc">Menor presupuesto</option>
          <option value="duration_asc">Más cortos</option>
        </Select>

        <Button
          type="button"
          variant="outline"
          aria-expanded={showMore}
          aria-controls="mas-filtros"
          onClick={() => setShowMore((value) => !value)}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          Más filtros
          {extraCount > 0 && (
            <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 text-caption font-semibold text-white">
              {extraCount}
            </span>
          )}
        </Button>
      </div>

      {showMore && (
        <div
          id="mas-filtros"
          className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <div className="space-y-1.5">
            <label htmlFor="desde" className="block text-small font-medium text-ink-800">
              Desde
            </label>
            <Input
              id="desde"
              type="date"
              defaultValue={params.get("desde") ?? ""}
              onChange={(event) => update("desde", event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="hasta" className="block text-small font-medium text-ink-800">
              Hasta
            </label>
            <Input
              id="hasta"
              type="date"
              defaultValue={params.get("hasta") ?? ""}
              onChange={(event) => update("hasta", event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="pago-min" className="block text-small font-medium text-ink-800">
              Pago mínimo por hora
            </label>
            <Input
              id="pago-min"
              type="number"
              inputMode="numeric"
              min={0}
              step={1000}
              placeholder="8000"
              defaultValue={params.get("pagoMin") ?? ""}
              onChange={(event) => updateDebounced("pagoMin", event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="duracion-max" className="block text-small font-medium text-ink-800">
              Duración máxima
            </label>
            <Select
              id="duracion-max"
              value={params.get("duracionMax") ?? ""}
              onChange={(event) => update("duracionMax", event.target.value)}
            >
              <option value="">Cualquiera</option>
              <option value="120">Hasta 2 h</option>
              <option value="240">Hasta 4 h</option>
              <option value="480">Hasta 8 h</option>
              <option value="720">Hasta 12 h</option>
            </Select>
          </div>

          <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
            <Chip
              label="Madrugada u overnight"
              active={params.get("overnight") === "1"}
              onToggle={() => update("overnight", params.get("overnight") === "1" ? "" : "1")}
            />
            <Chip
              label="Con bono"
              active={params.get("bono") === "1"}
              onToggle={() => update("bono", params.get("bono") === "1" ? "" : "1")}
            />
          </div>
        </div>
      )}

      {active.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <span className="text-caption text-ink-500">Filtros activos:</span>
          {active.map(([key, value]) => (
            <button
              key={`${key}=${value}`}
              type="button"
              onClick={() => update(key, "")}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-ink-100 py-1 pr-2 pl-3 text-caption font-medium text-ink-700 hover:bg-ink-200"
            >
              {filterLabel(key, value, categories)}
              <X size={13} aria-hidden="true" />
              <span className="sr-only">Quitar este filtro</span>
            </button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => push(new URLSearchParams())}>
            Limpiar todo
          </Button>
        </div>
      )}
    </div>
  );
}

/** Nombre legible de un filtro: `13-providencia` no le dice nada a nadie. */
function filterLabel(
  key: string,
  value: string,
  categories: readonly JobCategory[],
): string {
  switch (key) {
    case "q":
      return `«${value}»`;
    case "tipo":
      return value === CategoryGroup.FILA ? "Hacer una fila" : "Trámites y gestiones";
    case "categoria":
      return categories.find((c) => c.slug === value)?.name ?? value;
    case "region":
      return regions.find((r) => r.code === value)?.shortName ?? value;
    case "comuna":
      return (
        regions.flatMap((r) => r.communes).find((c) => c.code === value)?.name ?? value
      );
    case "desde":
      return `Desde ${value}`;
    case "hasta":
      return `Hasta ${value}`;
    case "pagoMin":
      return `Desde $${Number(value).toLocaleString("es-CL")}/h`;
    case "duracionMax":
      return `Hasta ${Number(value) / 60} h`;
    case "overnight":
      return "Madrugada u overnight";
    case "bono":
      return "Con bono";
    default:
      return `${key}: ${value}`;
  }
}

function Chip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        "h-11 rounded-[var(--radius-pill)] border px-4 text-small font-medium transition-colors",
        active
          ? "border-brand-600 bg-brand-600 text-white"
          : "border-line-strong bg-surface text-ink-700 hover:border-brand-300",
      )}
    >
      {label}
    </button>
  );
}
