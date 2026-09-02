import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Card, EmptyState, Icon } from "@/components/ui";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { effectiveDate } from "@/domain/nutrition/calendar";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { cargarPanelFinanzas } from "./queries";
import { PanelFinanzas } from "./PanelFinanzas";

export const dynamic = "force-dynamic";

/**
 * /finanzas — el panel del hogar.
 *
 * Las tres situaciones que NO pueden verse como «$0» tienen cada una su propia
 * pantalla acá:
 *
 *   - SIN HOGAR       → «crea o únete a un hogar».
 *   - SIN PERMISO     → «no tienes permiso para ver los montos» ([H17]). Es un
 *                       estado propio y NO una pantalla vacía: la RLS le
 *                       devuelve cero filas a quien no tiene FINANCE_VIEW, y
 *                       cero filas sumadas dan $0.
 *   - CONSULTA CAÍDA  → el `DataAccessError` sube y lo pinta `error.tsx`. Nunca
 *                       se atrapa acá para «mostrar algo»: mostrar algo, en una
 *                       pantalla de plata, es mostrar un número falso.
 */
export default async function FinanzasPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/finanzas");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="finanzas" title="Finanzas">
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

  const resultado = await cargarPanelFinanzas(supabase, householdId, hoy);

  if (resultado.estado === "SIN_PERMISO") {
    return (
      <AppShell active="finanzas" title="Finanzas">
        <div className="mt-md">
          <Card className="flex flex-col items-center gap-sm px-md py-lg text-center">
            <Icon name="lock" className="text-[32px] text-outline" />
            <p className="font-title-md text-title-md text-on-surface">
              No tienes permiso para ver los montos de este hogar
            </p>
            <p className="font-body-md text-body-md text-on-surface-variant">
              Sigues viendo la despensa completa —qué hay, cuánto queda y cuándo vence—; lo
              que no se muestra es cuánto costó. Pídeselo a quien administra el hogar.
            </p>
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      active="finanzas"
      title="Finanzas"
      subtitle="Lo que salió del bolsillo, lo que se consumió y lo que quedó guardado"
    >
      <div className="mt-md">
        <PanelFinanzas panel={resultado.datos} />
      </div>
    </AppShell>
  );
}
