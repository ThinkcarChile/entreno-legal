import { uuidParam } from "@/lib/route-params";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import {
  Card,
  Chip,
  DataRow,
  ErrorNote,
  Icon,
  LinkButton,
  Notice,
  Section,
} from "@/components/ui";
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

/** Píldora de versión: navega, por eso no es el `Chip` del kit. */
const VERSION = "shrink-0 rounded-full px-md py-2 font-label-md text-label-md transition-colors";
const VERSION_ON = `${VERSION} bg-primary text-on-primary`;
const VERSION_OFF = `${VERSION} bg-surface-container-high text-on-surface-variant`;

export default async function RecipeDetailPage({ params, searchParams }: Props) {
  const { id: idCrudo } = await params;
  const id = uuidParam(idCrudo);
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
    <AppShell active="recipes" title={recipe.name} subtitle={recipe.description ?? undefined}>
      <Link
        href="/recipes"
        className="mt-md inline-flex items-center gap-1 font-body-sm text-body-sm font-semibold text-primary"
      >
        <Icon name="arrow_back" className="text-[18px]" />
        Recetas
      </Link>

      <div className="mt-md mb-lg flex flex-wrap items-center gap-sm">
        <Chip tono="neutro" icon="history">
          Versión {recipe.versionNumber}
        </Chip>
        <Chip tono={recipe.status === "PUBLISHED" ? "primario" : "atencion"}>
          {STATUS_LABELS[recipe.status]}
        </Chip>
        {recipe.mealTypes.length > 0 && (
          <Chip tono="info" icon="schedule">
            {recipe.mealTypes.map((t) => MEAL_TYPE_LABELS[t]).join(", ")}
          </Chip>
        )}
        {recipe.baseTimeMinutes && (
          <Chip tono="neutro" icon="timer">
            {recipe.baseTimeMinutes} min
          </Chip>
        )}
      </div>

      {recipe.isGlobal && (
        <div className="mb-lg">
          <Notice icon="menu_book" tono="info">
            Receta de la biblioteca. No se edita: cópiala a tus recetas para cambiarla.
          </Notice>
        </div>
      )}

      {recipe.status === "PUBLISHED" && (
        <LinkButton
          href={`/recipes/${recipe.templateId}/family?v=${recipe.versionId}`}
          className="mb-md w-full py-3"
        >
          <Icon name="group" className="text-[18px]" />
          Ver porciones para mi familia
        </LinkButton>
      )}

      <RecipeVersionActions
        templateId={recipe.templateId}
        versionId={recipe.versionId}
        status={recipe.status}
        isOwn={recipe.isOwn}
      />

      {recipe.versions.length > 1 && (
        <nav
          aria-label="Versiones de la receta"
          className="hide-scrollbar mb-lg flex gap-sm overflow-x-auto pb-1 md:flex-wrap"
        >
          {recipe.versions.map((version) => (
            <Link
              key={version.id}
              href={`/recipes/${recipe.templateId}?v=${version.id}`}
              className={version.id === recipe.versionId ? VERSION_ON : VERSION_OFF}
            >
              v{version.versionNumber} · {STATUS_LABELS[version.status]}
            </Link>
          ))}
        </nav>
      )}

      <Section
        title="Ingredientes"
        hint={`Receta para ${recipe.baseServings} ${
          recipe.baseServings === 1 ? "persona" : "personas"
        }`}
      >
        <div className="grid grid-cols-1 gap-sm md:grid-cols-2">
          {bySlot.map(({ slot, components, alternatives }) => (
            <Card key={slot.id} className="p-md">
              <h4 className="mb-sm flex items-baseline gap-sm font-body-md text-body-md font-semibold text-on-surface">
                {slot.label ?? SLOT_LABELS[slot.slotType]}
                {!slot.isRequired && (
                  <span className="font-label-md text-label-md text-on-surface-variant">
                    opcional
                  </span>
                )}
              </h4>
              <ul className="space-y-sm">
                {components.map((component) => (
                  <li
                    key={component.id}
                    className="flex items-center gap-md rounded-xl bg-surface-container-low p-sm"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-container text-on-surface-variant">
                      <Icon name="nutrition" className="text-[20px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-body-md text-body-md text-on-surface">
                        {component.label}
                      </span>
                      <span className="block font-body-sm text-body-sm text-on-surface-variant">
                        {WEIGHT_BASIS_LABELS[component.weightBasis]}
                        {component.cookingMethod && (
                          <> · {COOKING_METHOD_LABELS[component.cookingMethod]}</>
                        )}
                        {component.isOptional && <> · opcional</>}
                      </span>
                    </span>
                    <span className="shrink-0 font-headline-sm text-headline-sm tabular-nums text-primary">
                      {Math.round(component.quantity).toLocaleString("es-CL")}{" "}
                      {component.unit === "G" ? "g" : "ml"}
                    </span>
                  </li>
                ))}
              </ul>

              {alternatives.length > 0 && (
                <div className="mt-md border-t border-outline-variant/40 pt-sm">
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    En vez de esto también sirve:{" "}
                    {alternatives
                      .map(
                        (a) =>
                          `${a.label} (${CULINARY_COMPATIBILITY_LABELS[a.culinaryCompatibility].toLowerCase()})`,
                      )
                      .join(", ")}
                    .
                  </p>
                  <p className="mt-1 font-label-md text-label-md text-outline">
                    Reemplazo de cocina, no equivalencia nutricional: la cantidad se recalcula.
                  </p>
                </div>
              )}
            </Card>
          ))}
        </div>
      </Section>

      {recipe.issues.length > 0 && (
        <div className="mb-lg space-y-sm">
          <ErrorNote>Hay ingredientes que no se pudieron calcular</ErrorNote>
          <Card className="p-md">
            <ul className="list-disc space-y-1 pl-lg font-body-sm text-body-sm text-on-surface-variant">
              {recipe.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
            <p className="mt-sm font-body-sm text-body-sm text-on-surface-variant">
              Esos ingredientes aportan <strong className="text-on-surface">desconocido</strong> al
              total, nunca cero.
            </p>
          </Card>
        </div>
      )}

      <Section title="Nutrición">
        <ServingsCalculator components={recipe.components} baseServings={recipe.baseServings} />
      </Section>

      {recipe.totalYieldFactor === null && (
        <div className="mb-lg">
          <Notice icon="scale" tono="info">
            Rendimiento después de cocinar: <strong>desconocido</strong>. Las cantidades son de los
            ingredientes tal como se compran o preparan; no se asume que el peso se mantenga.
          </Notice>
        </div>
      )}

      {recipe.steps.length > 0 && (
        <Section title="Preparación">
          <ol className="space-y-sm">
            {recipe.steps.map((step) => (
              <li key={step.id}>
                <Card className="flex gap-md p-md">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-fixed font-body-sm text-body-sm font-semibold text-on-primary-fixed">
                    {step.stepNumber}
                  </span>
                  <div className="min-w-0">
                    <p className="font-body-md text-body-md text-on-surface">{step.instruction}</p>
                    <p className="mt-1 font-label-md text-label-md text-on-surface-variant">
                      {step.durationMinutes && <>{step.durationMinutes} min</>}
                      {step.temperatureC && <> · {step.temperatureC} °C</>}
                      {step.parallelGroup !== null &&
                        (parallel.get(step.parallelGroup) ?? 0) > 1 && (
                          <> · se puede hacer mientras avanzan los otros</>
                        )}
                    </p>
                    {step.optionalCapability && step.manualAlternative && (
                      <p className="mt-sm rounded-xl bg-surface-container px-md py-sm font-body-sm text-body-sm text-on-surface-variant">
                        Sin {step.optionalCapability.toLowerCase().replace("_", " ")}:{" "}
                        {step.manualAlternative}
                      </p>
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {recipe.sources.length > 0 && (
        <Section title="De dónde salen los datos">
          <Card className="px-md py-xs">
            {recipe.sources.map((source, index) => (
              <DataRow key={`${source.label}-${index}`} label={source.label}>
                <span className="font-body-sm text-body-sm text-on-surface-variant">
                  {source.sourceType ? SOURCE_TYPE_LABELS[source.sourceType] : "Sin ficha"}
                  {source.frozen && (
                    <span className="ml-2 text-outline">congelada en esta versión</span>
                  )}
                </span>
              </DataRow>
            ))}
          </Card>
        </Section>
      )}
    </AppShell>
  );
}
