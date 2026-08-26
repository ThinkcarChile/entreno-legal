import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Icon, LinkButton } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { loadIngredientOptions } from "@/app/pantry/queries";
import { loadEquipment, loadPrepPreferences } from "../queries";
import { EquipmentBoard } from "./EquipmentBoard";

export const dynamic = "force-dynamic";

/**
 * Equipamiento del hogar (§10-§12): equipos con sus configuraciones (la
 * cortadora declara SUS cuchillas como datos, jamás una enum global) y las
 * preferencias de preparación por alimento ("zanahoria: rallado 4 mm").
 */
export default async function EquipmentPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/prep/equipment");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) redirect("/family");

  const [equipment, preferences, ingredientes] = await Promise.all([
    loadEquipment(supabase, householdId),
    loadPrepPreferences(supabase, householdId),
    loadIngredientOptions(supabase, householdId),
  ]);

  return (
    <AppShell
      active="prep"
      title="Equipos y preferencias"
      subtitle="Lo que hay en TU cocina y cómo prefieres preparar cada alimento. El equipo nunca es requisito: siempre existe el camino manual."
      action={
        <LinkButton href="/prep" variant="outline">
          <Icon name="arrow_back" className="text-[18px]" />
          Preparación
        </LinkButton>
      }
    >
      <div className="mt-md">
        <EquipmentBoard
          equipment={equipment}
          preferences={preferences}
          ingredientes={ingredientes}
        />
      </div>
    </AppShell>
  );
}
