import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
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
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="prep" />
      <header className="mb-4 flex items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Preparación</h1>
          <p className="text-xs text-[var(--ink)]/60">
            Qué conviene preparar ahora — y qué conviene no tocar todavía.
          </p>
        </div>
        <Link
          href="/prep/equipment"
          className="shrink-0 rounded-full border border-[var(--accent)] px-4 py-2.5 text-xs font-medium text-[var(--accent)]"
        >
          Equipos
        </Link>
      </header>
      <PrepHome plans={plans} />
    </main>
  );
}
