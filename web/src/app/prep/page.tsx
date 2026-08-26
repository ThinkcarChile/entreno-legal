import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell, ShellAction } from "@/components/AppShell";
import { Icon } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { loadPrepPlans } from "./queries";
import { PrepHome } from "./PrepHome";

export const dynamic = "force-dynamic";

/**
 * /prep (§15): "Preparación de esta compra" — resumen, bloques y planes.
 * Generar un plan es una SUGERENCIA (§17): la despensa cambia recién al
 * confirmar cada tarea en el modo cocina.
 */
export default async function PrepPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/prep");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) redirect("/family");

  const plans = await loadPrepPlans(supabase, householdId);

  return (
    <AppShell
      active="prep"
      title="Preparación"
      subtitle="Qué conviene preparar ahora — y qué conviene no tocar todavía."
      action={
        <ShellAction href="/prep/equipment">
          <Icon name="blender" className="text-[18px]" />
          Equipos
        </ShellAction>
      }
    >
      <div className="mt-md">
        <PrepHome plans={plans} />
      </div>
    </AppShell>
  );
}
