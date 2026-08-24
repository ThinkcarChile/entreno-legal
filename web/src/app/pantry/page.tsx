import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import { effectiveDate } from "@/domain/nutrition/calendar";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { loadIngredientOptions, loadOpenShortfalls, loadPantry } from "./queries";
import { loadStockInput } from "@/app/stock/queries";
import { analyzeStock } from "@/domain/stock/engine";
import { StockOverview } from "./StockOverview";
import Link from "next/link";
import { PantryBoard } from "./PantryBoard";

export const dynamic = "force-dynamic";

/**
 * La despensa (Sprint 7): lo que la casa tiene, lote por lote, con sus
 * vencimientos. Todo lo que se ve acá sale del libro mayor de movimientos.
 */
export default async function PantryPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/pantry");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <main className="mx-auto max-w-3xl px-4 pb-16">
        <AppNav active="pantry" />
        <h1 className="mb-2 mt-2 text-2xl font-semibold">Despensa</h1>
        <p className="rounded-2xl border border-dashed border-[var(--ink)]/20 p-6 text-center text-sm text-[var(--ink)]/60">
          Primero crea o únete a un hogar en la pestaña Familia.
        </p>
      </main>
    );
  }

  const { data: hogar, error: hogarError } = await supabase
    .from("households")
    .select("timezone")
    .eq("id", householdId)
    .maybeSingle();
  if (hogarError) throw new DataAccessError("zona horaria del hogar", hogarError);
  const hoy = effectiveDate(new Date(), hogar?.timezone ?? "America/Santiago");

  const pantry = await loadPantry(supabase, householdId);
  const ingredientes = await loadIngredientOptions(supabase, householdId);
  const desajustes = await loadOpenShortfalls(supabase, householdId);
  const stockInput = await loadStockInput(supabase, householdId, hoy, hogar?.timezone ?? "America/Santiago");
  const inteligencia = analyzeStock(stockInput);

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="pantry" />
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">Despensa</h1>
        <p className="mt-1 text-sm text-[var(--ink)]/60">
          {pantry.lots.length === 0
            ? "Todavía no hay nada registrado."
            : `${pantry.lots.length} ${pantry.lots.length === 1 ? "lote" : "lotes"} en casa`}
        </p>
      </header>

      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--ink)]/50">
          Reservas, cobertura y recomendaciones se calculan en vivo desde el libro mayor.
        </p>
        <Link
          href="/pantry/reorder"
          className="shrink-0 rounded-full border border-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent)]"
        >
          Ver reposición
        </Link>
      </div>

      <div className="mb-4">
        <StockOverview items={inteligencia} />
      </div>

      <PantryBoard pantry={pantry} today={hoy} ingredientes={ingredientes} desajustes={desajustes} />
    </main>
  );
}
