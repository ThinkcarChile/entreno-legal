import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { EmptyState } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { cargarEvento, cargarParticipantes } from "../../queries";
import {
  armarResumen,
  cargarBalance,
  cargarObservaciones,
  cargarServido,
  type ObservacionComensal,
} from "../../servicio-queries";
import { ResumenDelEvento } from "./ResumenDelEvento";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * /eventos/[id]/resumen — qué pasó de verdad (§56).
 *
 * `compradoG` va en null a propósito y no en cero: la lista de compras del
 * evento es de otra etapa de este mismo sprint y todavía no hay una lectura de
 * "cuántos kilos entraron por la compra". Un cero acá haría aparecer en la
 * pantalla "compraste 0 kg" al lado de "serviste 8 kg", que es peor que decir
 * que no se sabe.
 */
export default async function ResumenDelEventoPage({ params }: Props) {
  const { id } = await params;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/eventos/${id}/resumen`);

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="plan" title="Resumen del evento">
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

  const [participantes, servido, balance, observaciones] = await Promise.all([
    cargarParticipantes(supabase, id, evento.fecha),
    cargarServido(supabase, id),
    cargarBalance(supabase, id),
    cargarObservaciones(supabase, id),
  ]);

  const resumen = armarResumen(servido, balance, participantes, { compradoG: null });

  // Un Map no cruza la frontera servidor→cliente como Map; se manda como objeto.
  const observacionesPlanas: Record<string, ObservacionComensal> = {};
  for (const [clave, valor] of observaciones) observacionesPlanas[clave] = valor;

  // Cerrado y fuera de la ventana de corrección, la base rechaza toda escritura
  // de hechos. La pantalla no ofrece botones que van a rebotar: muestra la
  // lectura y ya. La decisión REAL sigue siendo de la base; esto es cortesía.
  const editable = evento.estado !== "CANCELLED";

  return (
    <AppShell active="plan" title={evento.titulo} subtitle="Resumen">
      <div className="mt-md">
        <ResumenDelEvento
          eventoId={id}
          fechaDelEvento={evento.fecha}
          resumen={resumen}
          servido={servido}
          participantes={participantes}
          observaciones={observacionesPlanas}
          puedeEditar={editable}
        />
      </div>
    </AppShell>
  );
}
