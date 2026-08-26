import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell, ShellAction } from "@/components/AppShell";
import { Icon } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { loadIngredientOptions } from "@/app/pantry/queries";
import { loadProcurementConfig } from "../queries";
import { SuppliersBoard } from "./SuppliersBoard";

export const dynamic = "force-dynamic";

/**
 * Configuración de abastecimiento (§8-§10): proveedores, sus presentaciones
 * (envase, mínimo, múltiplo, espera, días de entrega) y la política de compra
 * por alimento (proveedor preferido + días de pedido/recepción del hogar).
 * Sin frecuencias universales: cada alimento tiene su propia política.
 */
export default async function SuppliersPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/procurement/suppliers");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) redirect("/family");

  const [config, ingredientes] = await Promise.all([
    loadProcurementConfig(supabase, householdId),
    loadIngredientOptions(supabase, householdId),
  ]);

  return (
    <AppShell
      active="procurement"
      title="Proveedores"
      subtitle="Quién te vende qué, en qué presentación y con qué reglas de entrega."
      action={
        <ShellAction href="/procurement">
          <Icon name="arrow_back" className="text-[18px]" />
          Pedidos
        </ShellAction>
      }
    >
      <div className="mt-md">
        <p className="mb-sm font-label-md text-label-md uppercase text-primary">
          Gestión de abastecimiento
        </p>
        <SuppliersBoard config={config} ingredientes={ingredientes} />
      </div>
    </AppShell>
  );
}
