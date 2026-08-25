import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
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
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="procurement" />
      <header className="mb-4 flex items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Proveedores</h1>
          <p className="text-xs text-[var(--ink)]/60">
            Quién te vende qué, en qué presentación y con qué reglas de entrega.
          </p>
        </div>
        <Link
          href="/procurement"
          className="shrink-0 rounded-full border border-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent)]"
        >
          ← Pedidos
        </Link>
      </header>
      <SuppliersBoard config={config} ingredientes={ingredientes} />
    </main>
  );
}
