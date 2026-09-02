import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { EmptyState, Notice } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { diaCivilDelHogar } from "@/app/comi/historia-queries";
import { cargarEvento, cargarMenu, cargarParticipantes, cargarRevisionVigente } from "../../queries";
import { cargarServido } from "../../servicio-queries";
import { TableroDelDia } from "./TableroDelDia";
import { PanelDeServicio } from "./PanelDeServicio";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * /eventos/[id]/dia — el modo del día del evento.
 *
 * Es la pantalla que se mira con una mano llena de pinzas: letras grandes,
 * botones grandes, y SOLO lo que sirve ahora. Nada de administración —el menú,
 * el presupuesto y las revisiones viven en el evento, no acá.
 */
export default async function DiaDelEventoPage({ params }: Props) {
  const { id } = await params;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/eventos/${id}/dia`);

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="plan" title="Día del evento">
        <div className="mt-md">
          <EmptyState icon="group_add">
            Primero crea o únete a un hogar en la pestaña Familia.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  const evento = await cargarEvento(supabase, id);
  if (evento === null) notFound();

  const [participantes, revision, menu, servido, { hoy }] = await Promise.all([
    cargarParticipantes(supabase, id, evento.fecha),
    cargarRevisionVigente(supabase, id),
    cargarMenu(supabase, id),
    cargarServido(supabase, id),
    diaCivilDelHogar(supabase, householdId, new Date()),
  ]);

  // El contador vivo del §90 se alimenta de lo que EFECTIVAMENTE se anotó. Sin
  // renglones servidos se manda `null` —no se sabe— y no un cero que diría que
  // no ha salido nada a la mesa.
  const servidoTotal =
    servido.length === 0
      ? null
      : { gramos: servido.reduce((acc, r) => acc + r.cantidad, 0), base: "COOKED" as const };

  return (
    <AppShell active="plan" title={evento.titulo} subtitle="Hoy">
      <div className="mt-md space-y-lg">
        {evento.fecha !== hoy && (
          // Se puede entrar igual —a veces el asado se corre de día y nadie
          // actualizó la fecha— pero se avisa, porque marcar asistencia real en
          // el día equivocado ensucia el historial para siempre.
          <Notice icon="event_busy">
            Este evento está anotado para el {evento.fecha} y hoy es {hoy}. Lo que marques acá queda
            guardado igual: revisa la fecha si no calza.
          </Notice>
        )}

        <TableroDelDia
          eventoId={id}
          householdId={householdId}
          participantes={participantes}
          revision={revision}
          servido={servidoTotal}
        />

        <PanelDeServicio eventoId={id} menu={menu} servido={servido} />
      </div>
    </AppShell>
  );
}
