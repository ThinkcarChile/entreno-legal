import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Icon, LinkButton } from "@/components/ui";
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
          role: c.role,
        })),
      alternatives: draft.alternatives
        .filter((a) => a.slotId === slot.id && a.target.kind === "INGREDIENT")
        .map((a) => ({
          key: a.id,
          ingredientId: a.target.kind === "INGREDIENT" ? a.target.ingredientId : "",
          compatibility: a.culinaryCompatibility,
        })),
    })),
    steps: draft.steps.map((step) => ({
      key: step.id,
      instruction: step.instruction,
      durationMinutes: step.durationMinutes === null ? "" : String(step.durationMinutes),
    })),
  };

  return (
    <AppShell
      active="recipes"
      title="Editar borrador"
      subtitle={`Versión ${draft.versionNumber}. Al publicarla queda fija: los cambios posteriores crean una versión nueva.`}
      action={
        <LinkButton href={`/recipes/${id}`} variant="outline">
          <Icon name="arrow_back" className="text-[18px]" />
          Volver
        </LinkButton>
      }
    >
      <div className="mt-md">
        <RecipeForm ingredients={ingredients} initial={initial} />
      </div>
    </AppShell>
  );
}
