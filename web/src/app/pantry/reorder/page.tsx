import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import { effectiveDate, weekStart } from "@/domain/nutrition/calendar";
import { analyzeStock } from "@/domain/stock/engine";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { loadStockInput } from "@/app/stock/queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { ReorderBoard } from "./ReorderBoard";

export const dynamic = "force-dynamic";

/**
 * Dashboard de reposición (§33): qué comprar, cuánto, cuándo y por qué —
 * ordenado por urgencia. Recomienda; la lista de compras sigue siendo de
 * Shopping y nada se compra solo.
 */
export default async function ReorderPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/pantry/reorder");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) redirect("/pantry");

  const { data: hogar, error: hogarError } = await supabase
    .from("households")
    .select("timezone")
    .eq("id", householdId)
    .maybeSingle();
  if (hogarError) throw new DataAccessError("zona horaria del hogar", hogarError);
  const hoy = effectiveDate(new Date(), hogar?.timezone ?? "America/Santiago");

  const input = await loadStockInput(supabase, householdId, hoy, hogar?.timezone ?? "America/Santiago");
  const items = analyzeStock(input);
  const accionables = items.filter((i) =>
    ["REORDER_NOW", "REORDER_SOON", "WATCH"].includes(i.reorder.status),
  );

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="pantry" />
      <Link href="/pantry" className="text-xs text-[var(--accent)] underline">
        ← Despensa
      </Link>
      <header className="mb-4 mt-2">
        <h1 className="text-2xl font-semibold">Reposición</h1>
        <p className="mt-1 text-sm text-[var(--ink)]/60">
          {accionables.length === 0
            ? "Nada que reponer por ahora."
            : `${accionables.length} ${accionables.length === 1 ? "alimento necesita" : "alimentos necesitan"} atención`}
        </p>
      </header>

      <ReorderBoard items={accionables} weekStart={weekStart(hoy)} />
    </main>
  );
}
