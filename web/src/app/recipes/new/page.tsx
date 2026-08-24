import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import { loadIngredientOptions } from "../queries";
import { RecipeForm } from "../RecipeForm";

export const dynamic = "force-dynamic";

export default async function NewRecipePage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/recipes/new");

  const ingredients = await loadIngredientOptions(supabase);

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="recipes" />
      <Link href="/recipes" className="text-sm text-[var(--accent)]">
        ← Recetas
      </Link>
      <h1 className="mb-4 mt-2 text-2xl font-semibold">Crear receta</h1>

      {ingredients.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--ink)]/20 p-6 text-center text-sm text-[var(--ink)]/60">
          Todavía no hay alimentos en el catálogo. Agrega alguno antes de armar una receta.
        </p>
      ) : (
        <RecipeForm ingredients={ingredients} />
      )}
    </main>
  );
}
