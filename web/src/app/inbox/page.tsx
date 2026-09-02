import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { InboxList } from "@/components/assistant/InboxList";
import { EmptyState, ErrorNote, LinkButton, Notice } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireActor } from "@/lib/auth/actor";
import { leerBandeja } from "./queries";
import { badgeDeBandeja, coberturaDelLector, estadoDeBandeja } from "./vista";
import type { Cobertura, LecturaBandeja } from "./vista";

export const dynamic = "force-dynamic";

/**
 * /inbox — el centro de acciones.
 *
 * Es la cola DURABLE de lo que la casa tiene pendiente, y la puerta de entrada
 * de la app: lo que hay acá lo producen los motores y se lee sin salir a la
 * red, así que funciona con el proveedor de IA caído, con la cuota agotada o
 * sin consentimiento. El asistente cuelga de acá, no al revés.
 *
 * Tres pantallas distintas para tres cosas distintas, y esa es la mitad del
 * trabajo de este archivo: "no hay nada", "no hay nada PARA TI" (la bandeja
 * filtra por permiso) y "no pude leer".
 */
export default async function InboxPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/inbox");

  const { householdId, members } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="inbox" title="Pendientes">
        <div className="mt-md">
          <EmptyState icon="group_add">
            Primero crea o únete a un hogar en la pestaña Familia.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  // Los permisos deciden qué avisos se ven, así que también deciden qué frase
  // corresponde cuando la lista viene vacía. Si no se pueden leer, NO se asume
  // cobertura total: se dice que no se pudo.
  let cobertura: Cobertura = "PARCIAL";
  let permisosLeidos = true;
  try {
    const actor = await requireActor(
      supabase,
      householdId,
      members.map((m) => m.id),
    );
    cobertura = coberturaDelLector(
      actor,
      members.map((m) => m.id),
    );
  } catch {
    // No es un catch vacío: cambia la pantalla. Sin permisos resueltos no se
    // puede afirmar nada sobre lo que falta ver.
    permisosLeidos = false;
  }

  const lectura: LecturaBandeja = await leerBandeja(supabase, householdId);
  const estado = estadoDeBandeja(lectura, cobertura);
  const badge = badgeDeBandeja(lectura);

  return (
    <AppShell
      active="inbox"
      title="Pendientes"
      subtitle={
        estado.k === "CON_ITEMS"
          ? `${estado.items.length} ${estado.items.length === 1 ? "aviso" : "avisos"}`
          : undefined
      }
      badge={badge}
      action={<LinkButton href="/asistente" variant="outline">Preguntar</LinkButton>}
    >
      <div className="mt-md space-y-md">
        {!permisosLeidos && (
          <ErrorNote>
            No pude verificar tus permisos, así que no sé cuánto de esta bandeja
            te falta ver. Lo que aparece abajo puede estar incompleto.
          </ErrorNote>
        )}

        <InboxList estado={estado} />

        {estado.k === "CON_ITEMS" && (
          <Notice icon="info">
            Los avisos los producen los motores de la casa, no el asistente:
            acá no hay urgencias inventadas.
          </Notice>
        )}
      </div>
    </AppShell>
  );
}
