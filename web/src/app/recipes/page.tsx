import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
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

  const chip = "rounded-full px-3 py-2 text-xs font-medium";
  const chipOn = `${chip} bg-[var(--accent)] text-white`;
  const chipOff = `${chip} border border-[var(--ink)]/20 text-[var(--ink)]/70`;

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
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="recipes" />

      <header className="mb-4 flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold">Recetas</h1>
        <Link
          href="/recipes/new"
          className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
        >
          Crear receta
        </Link>
      </header>

      <form action="/recipes" className="mb-3">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Buscar por nombre"
          className="w-full rounded-full border border-[var(--ink)]/20 bg-white px-4 py-2 text-sm"
        />
        {mealType && <input type="hidden" name="type" value={mealType} />}
        {kind && <input type="hidden" name="kind" value={kind} />}
        {scope !== "all" && <input type="hidden" name="scope" value={scope} />}
      </form>

      <div className="mb-2 flex flex-wrap gap-2">
        <Link href={href({ scope: "all" })} className={scope === "all" ? chipOn : chipOff}>
          Todas
        </Link>
        <Link href={href({ scope: "mine" })} className={scope === "mine" ? chipOn : chipOff}>
          Mis recetas
        </Link>
        <Link href={href({ scope: "global" })} className={scope === "global" ? chipOn : chipOff}>
          Biblioteca
        </Link>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        <Link href={href({ type: undefined })} className={!mealType ? chipOn : chipOff}>
          Cualquier momento
        </Link>
        {MEAL_TYPES.filter((t) => t !== "OTHER").map((t) => (
          <Link key={t} href={href({ type: t })} className={mealType === t ? chipOn : chipOff}>
            {MEAL_TYPE_LABELS[t]}
          </Link>
        ))}
      </div>

      {recipes.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--ink)]/20 p-6 text-center text-sm text-[var(--ink)]/60">
          No hay recetas que coincidan. Prueba con otro filtro o crea una nueva.
        </p>
      ) : (
        <ul className="space-y-2">
          {recipes.map((recipe) => (
            <li key={recipe.templateId}>
              <Link
                href={`/recipes/${recipe.templateId}`}
                className="block rounded-2xl border border-[var(--ink)]/10 bg-white p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{recipe.name}</p>
                    <p className="mt-0.5 text-xs text-[var(--ink)]/60">
                      {KIND_LABELS[recipe.kind]}
                      {recipe.mealTypes.length > 0 && (
                        <> · {recipe.mealTypes.map((t) => MEAL_TYPE_LABELS[t]).join(", ")}</>
                      )}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {recipe.isGlobal ? (
                      <span className="rounded-full bg-[var(--ink)]/5 px-2 py-0.5 text-[11px] text-[var(--ink)]/60">
                        Biblioteca
                      </span>
                    ) : (
                      <span className="rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[11px] text-[var(--accent)]">
                        Mía
                      </span>
                    )}
                    <p className="mt-1 text-[11px] text-[var(--ink)]/50">
                      v{recipe.versionNumber}
                      {recipe.status !== "PUBLISHED" && ` · ${STATUS_LABELS[recipe.status]}`}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
