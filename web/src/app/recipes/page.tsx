import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell, ShellAction } from "@/components/AppShell";
import { CardLink, Chip, EmptyState, Icon, Section } from "@/components/ui";
import { loadRecipes } from "./queries";
import {
  MEAL_TYPES,
  MEAL_TYPE_LABELS,
  STATUS_LABELS,
  type MealType,
  type TemplateKind,
} from "@/domain/recipes/types";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ q?: string; type?: string; kind?: string; scope?: string }>;
}

const KIND_LABELS: Record<TemplateKind, string> = {
  MEAL: "Plato",
  SALAD: "Ensalada",
  DESSERT: "Postre",
};

/** Icono por clase de plantilla: la tarjeta se reconoce antes de leerla. */
const KIND_ICONS: Record<TemplateKind, string> = {
  MEAL: "restaurant",
  SALAD: "eco",
  DESSERT: "cake",
};

/**
 * Píldora de filtro. No es el `Chip` del kit a propósito: esto NAVEGA, y un
 * chip es texto de estado. Se queda como cadena de clases hasta que el kit
 * tenga su propia pieza de filtro.
 */
const FILTRO = "shrink-0 rounded-full px-md py-2 font-label-md text-label-md transition-colors";
const FILTRO_ON = `${FILTRO} bg-primary text-on-primary`;
const FILTRO_OFF = `${FILTRO} bg-surface-container-high text-on-surface-variant`;

export default async function RecipesPage({ searchParams }: Props) {
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const mealType = MEAL_TYPES.includes(params.type as MealType)
    ? (params.type as MealType)
    : undefined;
  const kind = ["MEAL", "SALAD", "DESSERT"].includes(params.kind ?? "")
    ? (params.kind as TemplateKind)
    : undefined;
  const scope = params.scope ?? "all";

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/recipes");

  const all = await loadRecipes(supabase, { mealType, kind, search: q || undefined });
  const recipes = all.filter((r) =>
    scope === "mine" ? !r.isGlobal : scope === "global" ? r.isGlobal : true,
  );

  function href(next: Record<string, string | undefined>) {
    const sp = new URLSearchParams();
    const merged = { q, type: mealType, kind, scope, ...next };
    for (const [k, v] of Object.entries(merged)) {
      if (v && v !== "all") sp.set(k, v);
    }
    const qs = sp.toString();
    return qs ? `/recipes?${qs}` : "/recipes";
  }

  return (
    <AppShell
      active="recipes"
      title="Recetas"
      subtitle="Platos, ensaladas y postres: los tuyos y los de la biblioteca."
      action={
        <ShellAction href="/recipes/new">
          <Icon name="add" className="text-[18px]" />
          Crear receta
        </ShellAction>
      }
    >
      <form action="/recipes" className="mt-md">
        <label className="relative block">
          <span className="sr-only">Buscar receta por nombre</span>
          <Icon
            name="search"
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-outline"
          />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Buscar por nombre"
            className="min-h-[48px] w-full rounded-full border border-outline-variant bg-surface-container-lowest py-3 pl-13 pr-md font-body-md text-body-md text-on-surface"
          />
        </label>
        {mealType && <input type="hidden" name="type" value={mealType} />}
        {kind && <input type="hidden" name="kind" value={kind} />}
        {scope !== "all" && <input type="hidden" name="scope" value={scope} />}
      </form>

      <div className="hide-scrollbar mt-md flex gap-sm overflow-x-auto pb-1 md:flex-wrap">
        <Link href={href({ scope: "all" })} className={scope === "all" ? FILTRO_ON : FILTRO_OFF}>
          Todas
        </Link>
        <Link href={href({ scope: "mine" })} className={scope === "mine" ? FILTRO_ON : FILTRO_OFF}>
          Mis recetas
        </Link>
        <Link
          href={href({ scope: "global" })}
          className={scope === "global" ? FILTRO_ON : FILTRO_OFF}
        >
          Biblioteca
        </Link>
      </div>

      <div className="hide-scrollbar mt-sm mb-lg flex gap-sm overflow-x-auto pb-1 md:flex-wrap">
        <Link href={href({ type: undefined })} className={!mealType ? FILTRO_ON : FILTRO_OFF}>
          Cualquier momento
        </Link>
        {MEAL_TYPES.filter((t) => t !== "OTHER").map((t) => (
          <Link key={t} href={href({ type: t })} className={mealType === t ? FILTRO_ON : FILTRO_OFF}>
            {MEAL_TYPE_LABELS[t]}
          </Link>
        ))}
      </div>

      <Section
        title={recipes.length === 1 ? "1 receta" : `${recipes.length} recetas`}
        hint={q ? `Coinciden con “${q}”.` : undefined}
      >
        {recipes.length === 0 ? (
          <EmptyState icon="menu_book">
            No hay recetas que coincidan. Prueba con otro filtro o crea una nueva.
          </EmptyState>
        ) : (
          <ul className="space-y-sm">
            {recipes.map((recipe) => (
              <li key={recipe.templateId}>
                <CardLink
                  href={`/recipes/${recipe.templateId}`}
                  className="flex items-center gap-md p-md"
                >
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary-fixed text-on-primary-fixed">
                    <Icon name={KIND_ICONS[recipe.kind]} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-body-md text-body-md font-semibold text-on-surface">
                      {recipe.name}
                    </span>
                    <span className="block truncate font-body-sm text-body-sm text-on-surface-variant">
                      {KIND_LABELS[recipe.kind]}
                      {recipe.mealTypes.length > 0 && (
                        <> · {recipe.mealTypes.map((t) => MEAL_TYPE_LABELS[t]).join(", ")}</>
                      )}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <Chip tono={recipe.isGlobal ? "neutro" : "primario"}>
                      {recipe.isGlobal ? "Biblioteca" : "Mía"}
                    </Chip>
                    <span className="font-label-md text-label-md text-on-surface-variant">
                      v{recipe.versionNumber}
                      {recipe.status !== "PUBLISHED" && ` · ${STATUS_LABELS[recipe.status]}`}
                    </span>
                  </span>
                </CardLink>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </AppShell>
  );
}
