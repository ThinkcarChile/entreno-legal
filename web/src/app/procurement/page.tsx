import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell, ShellAction } from "@/components/AppShell";
import { Icon, Notice } from "@/components/ui";
import { effectiveDate } from "@/domain/nutrition/calendar";
import { analyzeStock } from "@/domain/stock/engine";
import { planPurchases } from "@/domain/procurement/engine";
import type { ProcurementNeed } from "@/domain/procurement/types";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { loadStockInput } from "@/app/stock/queries";
import { loadOrders, loadPendingListItems, loadProcurementConfig, toExistingItems } from "./queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { ProcurementBoard } from "./ProcurementBoard";

export const dynamic = "force-dynamic";

/**
 * /procurement (§19): Próximos pedidos · Necesita acción · En camino ·
 * Recibidos recientemente. El motor planifica; las órdenes las acepta,
 * avanza y recibe UNA persona — nada se compra solo (§13).
 */
export default async function ProcurementPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/procurement");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) redirect("/family");

  const { data: hogar, error: hogarError } = await supabase
    .from("households")
    .select("timezone")
    .eq("id", householdId)
    .maybeSingle();
  if (hogarError) throw new DataAccessError("zona horaria del hogar", hogarError);
  const tz = hogar?.timezone ?? "America/Santiago";
  const hoy = effectiveDate(new Date(), tz);

  const [stockInput, config, orders, pendientesLista] = await Promise.all([
    loadStockInput(supabase, householdId, hoy, tz),
    loadProcurementConfig(supabase, householdId),
    loadOrders(supabase, householdId),
    loadPendingListItems(supabase, householdId),
  ]);

  const items = analyzeStock(stockInput);
  // Solo bases COMPRABLES: lo crudo (incluida la masa envasada) y lo escurrido.
  // Las sobras cocinadas no se piden a un proveedor.
  const needs: ProcurementNeed[] = items
    .filter((i) => i.weightBasis !== "COOKED")
    .map((i) => ({
      ingredientId: i.ingredientId,
      label: i.label,
      unit: i.unit,
      weightBasis: i.weightBasis,
      onHand: i.onHand,
      available: i.available,
      coverageDays: i.coverage.kind === "DAYS" ? i.coverage.days : null,
      dailyRate: i.rate.dailyRate,
      reorder: i.reorder,
    }));

  const plan = planPurchases({
    today: hoy,
    needs,
    supplierProducts: config.supplierProducts,
    policies: config.policies,
    existingItems: toExistingItems(orders),
    pendingListItems: pendientesLista,
    // Capacidad por alimento: sin fuente de datos todavía (la capacidad del
    // Sprint 8 es por UBICACIÓN y no se reparte por alimento sin inventar).
    capacity: {},
  });

  return (
    <AppShell
      active="procurement"
      title="Pedidos a proveedores"
      subtitle="El sistema sugiere qué pedir, cuánto, cuándo y a quién. Aprobar, pedir y recibir lo decides tú."
      action={
        <ShellAction href="/procurement/suppliers">
          <Icon name="storefront" className="text-[18px]" />
          Proveedores
        </ShellAction>
      }
    >
      <div className="mt-md">
        {config.supplierProducts.length === 0 && (
          <div className="mb-md">
            <Notice icon="storefront">
              Aún no hay proveedores con presentaciones.{" "}
              <Link href="/procurement/suppliers" className="font-semibold underline">
                Configura el primero
              </Link>{" "}
              para que las sugerencias traigan cantidades, fechas y proveedor.
            </Notice>
          </div>
        )}

        <ProcurementBoard plan={plan} orders={orders} today={hoy} timeZone={tz} />
      </div>
    </AppShell>
  );
}
