import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { EmptyState, Icon, LinkButton } from "@/components/ui";
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
    <AppShell
      active="recipes"
      title="Crear receta"
      subtitle="Arma el plato por partes: proteína, carbohidrato, verduras. La nutrición se calcula sola."
      action={
        <LinkButton href="/recipes" variant="outline">
          <Icon name="arrow_back" className="text-[18px]" />
          Recetas
        </LinkButton>
      }
    >
      <div className="mt-md">
        {ingredients.length === 0 ? (
          <EmptyState icon="nutrition">
            Todavía no hay alimentos en el catálogo. Agrega alguno antes de armar una receta.
          </EmptyState>
        ) : (
          <RecipeForm ingredients={ingredients} />
        )}
      </div>
    </AppShell>
  );
}
