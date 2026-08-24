import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import type { WeightBasis } from "@/domain/catalog/types";
import type { SlotType } from "@/domain/recipes/types";
import { loadDraftForEdit, loadIngredientOptions } from "../../queries";
import { RecipeForm, type RecipeFormInitial } from "../../RecipeForm";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string }>;
}

export default async function EditRecipePage({ params, searchParams }: Props) {
  const { id } = await params;
  const { v } = await searchParams;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/recipes/${id}/edit`);

  const [ingredients, draft] = await Promise.all([
    loadIngredientOptions(supabase),
    v ? loadDraftForEdit(supabase, id, v) : Promise.resolve(null),
  ]);

  // Solo se editan borradores propios: una versión publicada se versiona.
  if (!draft || !draft.isOwn) notFound();

  const initial: RecipeFormInitial = {
    templateId: draft.templateId,
    versionId: draft.versionId,
    name: draft.name,
    description: draft.description,
    kind: draft.kind,
    mealTypes: draft.mealTypes,
    baseServings: draft.baseServings,
    baseTimeMinutes: draft.baseTimeMinutes,
    slots: draft.slots.map((slot) => ({
      key: slot.id,
      slotType: slot.slotType as SlotType,
      isRequired: slot.isRequired,
      components: draft.components
        .filter((c) => c.slotId === slot.id && c.target.kind === "INGREDIENT")
        .map((c) => ({
          key: c.id,
          ingredientId: c.target.kind === "INGREDIENT" ? c.target.ingredientId : "",
          quantity: String(c.quantity),
          weightBasis: c.weightBasis as WeightBasis,
          cookingMethod: c.cookingMethod ?? "",
          isOptional: c.isOptional,
        })),
    })),
    steps: draft.steps.map((step) => ({
      key: step.id,
      instruction: step.instruction,
      durationMinutes: step.durationMinutes === null ? "" : String(step.durationMinutes),
    })),
  };

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="recipes" />
      <Link href={`/recipes/${id}`} className="text-sm text-[var(--accent)]">
        ← {draft.name}
      </Link>
      <h1 className="mb-1 mt-2 text-2xl font-semibold">Editar borrador</h1>
      <p className="mb-4 text-sm text-[var(--ink)]/60">
        Versión {draft.versionNumber}. Al publicarla queda fija: los cambios posteriores crean una
        versión nueva.
      </p>
      <RecipeForm ingredients={ingredients} initial={initial} />
    </main>
  );
}
