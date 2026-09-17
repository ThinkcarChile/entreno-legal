"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";

import { Search } from "lucide-react";

import { Button, Input, Select } from "@/components/ui";
import { CategoryGroup } from "@/lib/domain/enums";
import { regions } from "@/lib/geo/chile";

import type { JobCategory } from "@/lib/domain/types";

/**
 * Filtros del listado.
 *
 * El estado vive en la URL: los resultados son compartibles, indexables y el
 * botón "atrás" del navegador funciona como el usuario espera.
 */
export function JobFilters({ categories }: { categories: readonly JobCategory[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const update = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      next.delete("pagina");
      startTransition(() => router.push(`/trabajos?${next.toString()}`));
    },
    [params, router],
  );

  const clearAll = useCallback(() => {
    startTransition(() => router.push("/trabajos"));
  }, [router]);

  const selectedRegion = params.get("region") ?? "";
  const communes = regions.find((r) => r.code === selectedRegion)?.communes ?? [];
  const hasFilters = [...params.keys()].some((key) => key !== "pagina");

  return (
    <div
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
      data-pending={pending ? "" : undefined}
    >
      <div className="relative sm:col-span-2 lg:col-span-2">
        <Search
          size={16}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-400"
        />
        <Input
          type="search"
          placeholder="Buscar por título o comuna"
          aria-label="Buscar trabajos"
          defaultValue={params.get("q") ?? ""}
          className="pl-10"
          onChange={(event) => update("q", event.target.value)}
        />
      </div>

      <Select
        aria-label="Tipo de servicio"
        defaultValue={params.get("tipo") ?? ""}
        onChange={(event) => update("tipo", event.target.value)}
      >
        <option value="">Todos los tipos</option>
        <option value={CategoryGroup.FILA}>Hacer una fila</option>
        <option value={CategoryGroup.TRAMITE}>Trámites y gestiones</option>
      </Select>

      <Select
        aria-label="Categoría"
        defaultValue={params.get("categoria") ?? ""}
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
        defaultValue={selectedRegion}
        onChange={(event) => update("region", event.target.value)}
      >
        <option value="">Todo Chile</option>
        {regions.map((region) => (
          <option key={region.code} value={region.code}>
            {region.shortName}
          </option>
        ))}
      </Select>

      {communes.length > 0 && (
        <Select
          aria-label="Comuna"
          defaultValue={params.get("comuna") ?? ""}
          onChange={(event) => update("comuna", event.target.value)}
        >
          <option value="">Todas las comunas</option>
          {communes.map((commune) => (
            <option key={commune.code} value={commune.code}>
              {commune.name}
            </option>
          ))}
        </Select>
      )}

      <Select
        aria-label="Ordenar"
        defaultValue={params.get("orden") ?? "recent"}
        onChange={(event) => update("orden", event.target.value)}
      >
        <option value="recent">Más recientes</option>
        <option value="starts_soon">Comienzan antes</option>
        <option value="budget_desc">Mejor pago</option>
        <option value="budget_asc">Menor presupuesto</option>
        <option value="duration_asc">Más cortos</option>
      </Select>

      <div className="sm:col-span-2 lg:col-span-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <label htmlFor="desde" className="mb-1 block text-xs font-medium text-ink-600">
              Desde
            </label>
            <Input
              id="desde"
              type="date"
              defaultValue={params.get("desde") ?? ""}
              onChange={(event) => update("desde", event.target.value)}
            />
          </div>
          <div className="w-40">
            <label htmlFor="hasta" className="mb-1 block text-xs font-medium text-ink-600">
              Hasta
            </label>
            <Input
              id="hasta"
              type="date"
              defaultValue={params.get("hasta") ?? ""}
              onChange={(event) => update("hasta", event.target.value)}
            />
          </div>
          <div className="w-44">
            <label htmlFor="pago-min" className="mb-1 block text-xs font-medium text-ink-600">
              Pago mínimo por hora
            </label>
            <Input
              id="pago-min"
              type="number"
              min={0}
              step={1000}
              placeholder="8000"
              defaultValue={params.get("pagoMin") ?? ""}
              onChange={(event) => update("pagoMin", event.target.value)}
            />
          </div>
          <div className="w-44">
            <label htmlFor="duracion-max" className="mb-1 block text-xs font-medium text-ink-600">
              Duración máxima
            </label>
            <Select
              id="duracion-max"
              defaultValue={params.get("duracionMax") ?? ""}
              onChange={(event) => update("duracionMax", event.target.value)}
            >
              <option value="">Cualquiera</option>
              <option value="120">Hasta 2 h</option>
              <option value="240">Hasta 4 h</option>
              <option value="480">Hasta 8 h</option>
              <option value="720">Hasta 12 h</option>
            </Select>
          </div>

          <Toggle
            label="Madrugada u overnight"
            active={params.get("overnight") === "1"}
            onToggle={() => update("overnight", params.get("overnight") === "1" ? "" : "1")}
          />
          <Toggle
            label="Con bono"
            active={params.get("bono") === "1"}
            onToggle={() => update("bono", params.get("bono") === "1" ? "" : "1")}
          />

          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearAll}>
              Limpiar filtros
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Toggle({
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
      className={
        active
          ? "h-11 rounded-full border border-brand-600 bg-brand-600 px-4 text-sm font-medium text-white"
          : "h-11 rounded-full border border-ink-200 bg-white px-4 text-sm font-medium text-ink-700 hover:border-brand-300"
      }
    >
      {label}
    </button>
  );
}
