"use client";

import { cn } from "@/lib/utils/cn";
import { CategoryGroup } from "@/lib/domain/enums";

import type { StepProps } from "./types";
import type { JobCategory } from "@/lib/domain/types";

const groups = [
  {
    id: CategoryGroup.FILA,
    title: "Hacer una fila",
    description: "Conciertos, lanzamientos, restaurantes, instituciones y filas nocturnas.",
  },
  {
    id: CategoryGroup.TRAMITE,
    title: "Trámite o gestión",
    description: "Retirar o entregar documentos, retirar pedidos y esperas presenciales.",
  },
];

export function StepCategory({
  draft,
  errors,
  update,
  categories,
}: StepProps & { categories: readonly JobCategory[] }) {
  const selected = categories.find((c) => c.id === draft.categoryId);
  const activeGroup = selected?.group;

  return (
    <div className="space-y-8">
      <fieldset>
        <legend className="text-sm font-medium text-ink-800">¿Qué necesitas?</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {groups.map((group) => {
            const active = activeGroup === group.id;
            return (
              <button
                key={group.id}
                type="button"
                onClick={() => update({ categoryId: undefined })}
                aria-pressed={active}
                className={cn(
                  "rounded-[var(--radius-card)] border p-5 text-left transition-colors",
                  active
                    ? "border-brand-600 bg-brand-50/60 ring-1 ring-brand-600"
                    : "border-ink-200 bg-white hover:border-brand-200 hover:bg-brand-50/30",
                )}
              >
                <span className="block font-semibold text-ink-900">{group.title}</span>
                <span className="mt-1 block text-sm text-ink-600">{group.description}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium text-ink-800">Elige la subcategoría</legend>
        <div className="mt-3 space-y-6">
          {groups.map((group) => (
            <div key={group.id}>
              <p className="text-xs font-semibold tracking-wide text-ink-500 uppercase">
                {group.title}
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {categories
                  .filter((category) => category.group === group.id)
                  .map((category) => {
                    const active = draft.categoryId === category.id;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        onClick={() => update({ categoryId: category.id })}
                        aria-pressed={active}
                        className={cn(
                          "rounded-[var(--radius-control)] border px-4 py-3 text-left transition-colors",
                          active
                            ? "border-brand-600 bg-brand-50/60 ring-1 ring-brand-600"
                            : "border-ink-200 bg-white hover:border-brand-200",
                        )}
                      >
                        <span className="block text-sm font-medium text-ink-900">
                          {category.name}
                        </span>
                        {category.description && (
                          <span className="mt-0.5 block text-xs text-ink-500">
                            {category.description}
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
        {errors.categoryId && (
          <p className="mt-3 text-sm text-danger-600" role="alert">
            {errors.categoryId}
          </p>
        )}
      </fieldset>
    </div>
  );
}
