import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { diaCivilDelHogar } from "@/app/comi/historia-queries";
import { FormularioNuevoEvento } from "./FormularioNuevoEvento";

export const dynamic = "force-dynamic";

/**
 * El primer paso del armador: quién, qué y cuándo.
 *
 * Los otros nueve pasos —participantes, invitados, carnes, acompañamientos,
 * bebidas, sobrante, equipamiento, calcular— viven en la pantalla del evento y
 * no acá. La razón es concreta: un invitado o un corte necesitan un evento al
 * cual colgarse, y sostener diez pasos en memoria antes de guardar nada
 * significa que cerrar la app sin querer borra media hora de trabajo.
 */
export default async function NuevoEventoPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/eventos/nuevo");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="plan" title="Nuevo evento">
        <div className="mt-md">
          <EmptyState icon="group_add">
            Primero crea o únete a un hogar en la pestaña Familia.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  const { hoy } = await diaCivilDelHogar(supabase, householdId, new Date());

  return (
    <AppShell active="plan" title="Nuevo evento" subtitle="Paso 1 de 2">
      <div className="mt-md">
        <FormularioNuevoEvento householdId={householdId} hoy={hoy} />
      </div>
    </AppShell>
  );
}
