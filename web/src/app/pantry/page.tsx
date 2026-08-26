import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell, ShellAction } from "@/components/AppShell";
import { Card, EmptyState, Icon } from "@/components/ui";
import { effectiveDate } from "@/domain/nutrition/calendar";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { loadIngredientOptions, loadOpenShortfalls, loadPantry } from "./queries";
import { loadStockInput } from "@/app/stock/queries";
import { analyzeStock } from "@/domain/stock/engine";
import { StockOverview } from "./StockOverview";
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
      <AppShell active="pantry" title="Despensa">
        <div className="mt-md">
          <EmptyState icon="group_add">
            Primero crea o únete a un hogar en la pestaña Familia.
          </EmptyState>
        </div>
      </AppShell>
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
    <AppShell
      active="pantry"
      title="Despensa"
      subtitle={
        pantry.lots.length === 0
          ? "Todavía no hay nada registrado."
          : `${pantry.lots.length} ${pantry.lots.length === 1 ? "lote" : "lotes"} en casa`
      }
      action={
        <ShellAction href="/pantry/reorder">
          <Icon name="shopping_cart" className="text-[18px]" />
          Ver reposición
        </ShellAction>
      }
    >
      <div className="mt-md">
        <StockOverview items={inteligencia} />

        <PantryBoard
          pantry={pantry}
          today={hoy}
          ingredientes={ingredientes}
          desajustes={desajustes}
        />

        <Card className="mt-lg flex items-start gap-sm p-md">
          <Icon name="calculate" className="mt-0.5 shrink-0 text-primary" />
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Reservas, cobertura y recomendaciones se calculan en vivo desde el libro mayor.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
