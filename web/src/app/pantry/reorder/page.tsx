import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Icon, LinkButton, Notice } from "@/components/ui";
import { effectiveDate, weekStart } from "@/domain/nutrition/calendar";
import { analyzeStock } from "@/domain/stock/engine";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { loadStockInput } from "@/app/stock/queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { ReorderBoard } from "./ReorderBoard";
import { z } from "zod";
import { parseRows, uuid } from "@/lib/supabase/rows";

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
  // Gate final §6 [U-3]: lo que NO se pudo evaluar se dice acá mismo, en la
  // pantalla donde se decide qué comprar — no solo en /pantry. "Nada que
  // reponer" con demanda sin resolver escondida era un verde mentiroso.
  const sinResolver = items.filter((i) => i.reorder.status === "UNRESOLVED");

  // Sugerencias que YA están pendientes en la lista de esta semana, para que
  // el botón no se resetee al navegar (idempotencia visible).
  const inicioSemana = weekStart(hoy);
  const { data: sugeridosData, error: sugeridosError } = await supabase
    .from("shopping_list_items")
    .select("ingredient_id, unit, purchase_basis, status, shopping_lists!inner ( plan_id, weekly_plans!inner ( week_start ) )")
    .eq("source", "STOCK_INTELLIGENCE")
    .eq("status", "PENDING");
  if (sugeridosError) throw new DataAccessError("sugerencias existentes", sugeridosError);
  const sugeridos = parseRows(
    z.object({ ingredient_id: uuid.nullable(), unit: z.string(), purchase_basis: z.string() }).passthrough(),
    sugeridosData,
    "sugerencias existentes",
  )
    .filter((f) => f.ingredient_id !== null)
    // [S-2]: la clave lleva la base (DRAINED en la lista = la línea DRAINED,
    // no cualquier bucket del alimento).
    .map((f) => `${f.ingredient_id}${f.unit}${f.purchase_basis === "DRAINED" ? "DRAINED" : "RAW"}`);

  return (
    <AppShell
      active="pantry"
      title="Reposición"
      subtitle={
        accionables.length === 0
          ? "Nada que reponer por ahora."
          : `${accionables.length} ${accionables.length === 1 ? "alimento necesita" : "alimentos necesitan"} atención`
      }
      action={
        <LinkButton href="/pantry" variant="outline">
          <Icon name="arrow_back" className="text-[18px]" />
          Despensa
        </LinkButton>
      }
    >
      <div className="mt-md space-y-md">
        {sinResolver.length > 0 && (
          <Notice icon="help">
            <p className="font-semibold">
              {sinResolver.length}{" "}
              {sinResolver.length === 1
                ? "alimento no se pudo evaluar"
                : "alimentos no se pudieron evaluar"}
            </p>
            <ul className="mt-sm space-y-1">
              {sinResolver.map((i) => (
                <li key={i.ingredientId + i.unit + i.weightBasis}>
                  {i.label}: demanda en una base sin factor de conversión anotado — puede esconder
                  un faltante real.
                </li>
              ))}
            </ul>
          </Notice>
        )}

        {input.excludedProductLots > 0 && (
          <Notice icon="inventory_2">
            {input.excludedProductLots}{" "}
            {input.excludedProductLots === 1
              ? "lote con identidad de producto comercial queda"
              : "lotes con identidad de producto comercial quedan"}{" "}
            fuera de este análisis: el motor de reposición trabaja por alimento. Revísalos a mano en
            la despensa.
          </Notice>
        )}
      </div>

      <ReorderBoard items={accionables} weekStart={inicioSemana} yaSugeridos={sugeridos} />
    </AppShell>
  );
}
