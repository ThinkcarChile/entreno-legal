import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import { SOURCE_TYPE_LABELS, WEIGHT_BASIS_LABELS } from "@/domain/catalog/types";
import {
  COOKING_METHOD_LABELS,
  CULINARY_COMPATIBILITY_LABELS,
  MEAL_TYPE_LABELS,
  SLOT_LABELS,
  STATUS_LABELS,
} from "@/domain/recipes/types";
import { loadRecipeDetail } from "../queries";
import { ServingsCalculator } from "./ServingsCalculator";
import { RecipeVersionActions } from "./RecipeVersionActions";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string }>;
}

export default async function RecipeDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { v } = await searchParams;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/recipes/${id}`);

  const recipe = await loadRecipeDetail(supabase, id, v);
  if (!recipe) notFound();

  const bySlot = recipe.slots.map((slot) => ({
    slot,
    components: recipe.components.filter((c) => c.slotId === slot.id),
    alternatives: recipe.alternatives.filter((a) => a.slotId === slot.id),
  }));

  const parallel = new Map<number, number>();
  for (const step of recipe.steps) {
    if (step.parallelGroup !== null) {
      parallel.set(step.parallelGroup, (parallel.get(step.parallelGroup) ?? 0) + 1);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="recipes" />

      <Link href="/recipes" className="text-sm text-[var(--accent)]">
        ← Recetas
      </Link>

      <header className="mb-4 mt-2">
        <h1 className="text-2xl font-semibold">{recipe.name}</h1>
        <p className="mt-1 text-sm text-[var(--ink)]/60">
          Versión {recipe.versionNumber} · {STATUS_LABELS[recipe.status]}
          {recipe.mealTypes.length > 0 && (
            <> · {recipe.mealTypes.map((t) => MEAL_TYPE_LABELS[t]).join(", ")}</>
          )}
          {recipe.baseTimeMinutes && <> · {recipe.baseTimeMinutes} min</>}
        </p>
        {recipe.description && (
          <p className="mt-2 text-sm text-[var(--ink)]/70">{recipe.description}</p>
        )}
        {recipe.isGlobal && (
          <p className="mt-2 rounded-xl bg-[var(--ink)]/5 px-3 py-2 text-xs text-[var(--ink)]/70">
            Receta de la biblioteca. No se edita: cópiala a tus recetas para cambiarla.
          </p>
        )}
      </header>

      <RecipeVersionActions
        templateId={recipe.templateId}
        versionId={recipe.versionId}
        status={recipe.status}
        isOwn={recipe.isOwn}
      />

      {recipe.versions.length > 1 && (
        <nav className="mb-4 flex flex-wrap gap-2">
          {recipe.versions.map((version) => (
            <Link
              key={version.id}
              href={`/recipes/${recipe.templateId}?v=${version.id}`}
              className={`rounded-full px-3 py-1 text-xs ${
                version.id === recipe.versionId
                  ? "bg-[var(--accent)] text-white"
                  : "border border-[var(--ink)]/20 text-[var(--ink)]/70"
              }`}
            >
              v{version.versionNumber} · {STATUS_LABELS[version.status]}
            </Link>
          ))}
        </nav>
      )}

      <section className="mb-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
          Ingredientes · receta para {recipe.baseServings}{" "}
          {recipe.baseServings === 1 ? "persona" : "personas"}
        </h2>
        {bySlot.map(({ slot, components, alternatives }) => (
          <div key={slot.id} className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
            <h3 className="mb-2 text-sm font-medium">
              {slot.label ?? SLOT_LABELS[slot.slotType]}
              {!slot.isRequired && (
                <span className="ml-2 text-[11px] font-normal text-[var(--ink)]/50">opcional</span>
              )}
            </h3>
            <ul className="space-y-1.5">
              {components.map((component) => (
                <li key={component.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span>
                    {component.label}
                    <span className="ml-2 text-[11px] text-[var(--ink)]/50">
                      {WEIGHT_BASIS_LABELS[component.weightBasis]}
                      {component.cookingMethod && (
                        <> · {COOKING_METHOD_LABELS[component.cookingMethod]}</>
                      )}
                      {component.isOptional && <> · opcional</>}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {Math.round(component.quantity).toLocaleString("es-CL")}{" "}
                    {component.unit === "G" ? "g" : "ml"}
                  </span>
                </li>
              ))}
            </ul>

            {alternatives.length > 0 && (
              <div className="mt-3 border-t border-[var(--ink)]/5 pt-2">
                <p className="text-[11px] text-[var(--ink)]/60">
                  En vez de esto también sirve:{" "}
                  {alternatives
                    .map(
                      (a) =>
                        `${a.label} (${CULINARY_COMPATIBILITY_LABELS[a.culinaryCompatibility].toLowerCase()})`,
                    )
                    .join(", ")}
                  .
                </p>
                <p className="mt-1 text-[11px] text-[var(--ink)]/45">
                  Reemplazo de cocina, no equivalencia nutricional: la cantidad se recalcula.
                </p>
              </div>
            )}
          </div>
        ))}
      </section>

      {recipe.issues.length > 0 && (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-medium">Hay ingredientes que no se pudieron calcular</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {recipe.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            Esos ingredientes aportan <strong>desconocido</strong> al total, nunca cero.
          </p>
        </div>
      )}

      <section className="mb-5">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
          Nutrición
        </h2>
        <ServingsCalculator components={recipe.components} baseServings={recipe.baseServings} />
      </section>

      {recipe.totalYieldFactor === null && (
        <p className="mb-5 rounded-xl bg-[var(--ink)]/5 px-3 py-2 text-xs text-[var(--ink)]/70">
          Rendimiento después de cocinar: <strong>desconocido</strong>. Las cantidades son de los
          ingredientes tal como se compran o preparan; no se asume que el peso se mantenga.
        </p>
      )}

      {recipe.steps.length > 0 && (
        <section className="mb-5">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
            Preparación
          </h2>
          <ol className="space-y-2">
            {recipe.steps.map((step) => (
              <li
                key={step.id}
                className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4 text-sm"
              >
                <div className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-xs font-medium text-[var(--accent)]">
                    {step.stepNumber}
                  </span>
                  <div>
                    <p>{step.instruction}</p>
                    <p className="mt-1 text-[11px] text-[var(--ink)]/50">
                      {step.durationMinutes && <>{step.durationMinutes} min</>}
                      {step.temperatureC && <> · {step.temperatureC} °C</>}
                      {step.parallelGroup !== null &&
                        (parallel.get(step.parallelGroup) ?? 0) > 1 && (
                          <> · se puede hacer mientras avanzan los otros</>
                        )}
                    </p>
                    {step.optionalCapability && step.manualAlternative && (
                      <p className="mt-2 rounded-xl bg-[var(--ink)]/5 px-3 py-2 text-[11px] text-[var(--ink)]/70">
                        Sin {step.optionalCapability.toLowerCase().replace("_", " ")}:{" "}
                        {step.manualAlternative}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {recipe.sources.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--ink)]/60">
            De dónde salen los datos
          </h2>
          <ul className="divide-y divide-[var(--ink)]/5 rounded-2xl border border-[var(--ink)]/10 bg-white text-xs">
            {recipe.sources.map((source, index) => (
              <li key={`${source.label}-${index}`} className="flex justify-between gap-3 px-4 py-2">
                <span>{source.label}</span>
                <span className="shrink-0 text-right text-[var(--ink)]/60">
                  {source.sourceType ? SOURCE_TYPE_LABELS[source.sourceType] : "Sin ficha"}
                  {source.frozen && (
                    <span className="ml-2 text-[var(--ink)]/40">congelada en esta versión</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
