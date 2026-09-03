import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { diaCivilDelHogar } from "@/app/comi/historia-queries";
import {
  cargarComidasCubiertas,
  cargarEvento,
  cargarInvitadosDelHogar,
  cargarMenu,
  cargarParticipantes,
  cargarRevisionVigente,
} from "../queries";
import { cargarRelevosDeEventos } from "@/app/demanda-abierta";
import { TableroEvento } from "./TableroEvento";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * /eventos/[id] — el tablero del evento.
 *
 * Está ordenado ANTES / HOY / DESPUÉS porque un evento es un objeto que cambia
 * de pregunta según el día: antes uno pregunta "¿qué compro?", el día del asado
 * "¿qué hago ahora?" y después "¿cuánto sobró?". Mostrar las tres cosas
 * mezcladas obliga a leer todo para encontrar la que sirve hoy.
 */
export default async function EventoPage({ params }: Props) {
  const { id } = await params;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/eventos/${id}`);

  const { householdId, members } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="plan" title="Evento">
        <div className="mt-md">
          <EmptyState icon="group_add">
            Primero crea o únete a un hogar en la pestaña Familia.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  const evento = await cargarEvento(supabase, id);
  // Que no exista y que no sea de tu hogar se ven igual desde acá, y así tiene
  // que ser: contestar "existe pero no es tuyo" ya filtra información de otra
  // familia. La RLS decide y nosotros mostramos "no está".
  if (evento === null) notFound();

  const [participantes, menu, invitados, revision, { hoy }, relevosDelHogar, comidasCubiertas] =
    await Promise.all([
      cargarParticipantes(supabase, id, evento.fecha),
      cargarMenu(supabase, id),
      cargarInvitadosDelHogar(supabase, householdId),
      cargarRevisionVigente(supabase, id),
      diaCivilDelHogar(supabase, householdId, new Date()),
      // H20: qué comidas del plan está relevando ESTE evento, hoy, de verdad. Se
      // lee de la base y no se deduce de la configuración: que el evento tenga
      // comida declarada no basta —hace falta además estar confirmado y tener
      // gente del hogar en el roster—, y decir "reemplaza el almuerzo" cuando no
      // lo reemplaza es justo la sensación de estar resuelto que costó el sprint.
      cargarRelevosDeEventos(
        supabase,
        members.map((m) => m.id),
        evento.fecha,
        evento.fechaFin ?? evento.fecha,
      ),
      // TODAS las comidas que el evento reemplaza. `evento.comida` sólo trae la
      // primera (0061): decidir con ella es cómo se compraba dos veces la cena.
      cargarComidasCubiertas(supabase, id),
    ]);
  const relevos = relevosDelHogar.filter((r) => r.eventoId === id);

  return (
    <AppShell active="plan" title={evento.titulo} subtitle={evento.fecha} wide>
      <div className="mt-md">
        <TableroEvento
          evento={evento}
          hoy={hoy}
          householdId={householdId}
          participantes={participantes}
          menu={menu}
          invitadosDelHogar={invitados}
          miembros={members.map((m) => ({ id: m.id, nombre: m.displayName }))}
          revision={revision}
          relevos={relevos}
          comidasCubiertas={comidasCubiertas}
        />
      </div>
    </AppShell>
  );
}
