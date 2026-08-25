import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
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
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="prep" />
      <header className="mb-4 flex items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Equipos y preferencias</h1>
          <p className="text-xs text-[var(--ink)]/60">
            Lo que hay en TU cocina y cómo prefieres preparar cada alimento. El equipo nunca es
            requisito: siempre existe el camino manual.
          </p>
        </div>
        <Link
          href="/prep"
          className="shrink-0 rounded-full border border-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent)]"
        >
          ← Preparación
        </Link>
      </header>
      <EquipmentBoard equipment={equipment} preferences={preferences} ingredientes={ingredientes} />
    </main>
  );
}
