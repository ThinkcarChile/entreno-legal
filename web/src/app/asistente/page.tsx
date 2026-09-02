import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { InboxList } from "@/components/assistant/InboxList";
import { EmptyState, ErrorNote, Notice, Section } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { createSupabaseServer } from "@/lib/supabase/server";
import { leerBandeja } from "@/app/inbox/queries";
import { badgeDeBandeja, estadoDeBandeja } from "@/app/inbox/vista";
import { AssistantShell } from "./AssistantShell";
import { enviarTurno } from "./acciones";
import { leerConsentimientoDelHogar } from "./queries";
import type { EstadoAsistente } from "./turnos";

export const dynamic = "force-dynamic";

/**
 * /asistente — el chat.
 *
 * Es una CAPACIDAD, no el vestíbulo. La puerta de entrada de la app es /inbox,
 * que la producen los motores y se lee sin salir a la red; acá se viene a
 * preguntar algo que ninguna pantalla contesta. Por eso lo primero que se ve,
 * incluso con la IA apagada, son los pendientes de verdad y los atajos
 * deterministas: la pantalla sirve para algo aunque el proveedor no exista.
 *
 * El chat PROPONE. Lo que escribe en la base es la tarjeta de confirmación, que
 * vive en /asistente/propuesta/[id] con su token de un solo uso.
 */
export default async function AsistentePage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/asistente");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="assistant" title="Asistente">
        <div className="mt-md">
          <EmptyState icon="group_add">
            Primero crea o únete a un hogar en la pestaña Familia.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  const consentimiento = await leerConsentimientoDelHogar(supabase, householdId);
  const lectura = await leerBandeja(supabase, householdId);

  /*
   * Hoy no hay proveedor conectado de punta a punta (ver `acciones.ts`), así
   * que el estado es SIN_CONFIGURAR pase lo que pase con el consentimiento: si
   * no hay a quién preguntarle, pedir un permiso que no compra nada es ruido.
   *
   * El consentimiento se lee igual y se muestra aparte, por dos razones: es el
   * gate que manda apenas exista el ejecutor, y "no pude leerlo" NO puede
   * confundirse con "no lo hay" ni —peor— con "sí lo hay".
   */
  const estado: EstadoAsistente = { k: "SIN_CONFIGURAR" };

  const pendientes = estadoDeBandeja(lectura, "PARCIAL");

  return (
    <AppShell
      active="assistant"
      title="Asistente"
      subtitle="Te propongo; tú confirmas"
      badge={badgeDeBandeja(lectura)}
    >
      <div className="mt-md space-y-lg">
        {consentimiento === "NO_SE_PUDO_LEER" && (
          <ErrorNote>
            No pude verificar si esta casa autorizó usar IA. Mientras no lo sepa,
            no mando nada afuera: eso NO significa que falte el permiso, significa
            que no pude leerlo.
          </ErrorNote>
        )}

        {consentimiento === "SIN_CONSENTIMIENTO" && (
          <Notice icon="lock">
            Cuando el asistente esté conectado va a necesitar el permiso de IA de
            la casa, que hoy no está activo. Nada de esta pantalla sale de acá
            mientras tanto.
          </Notice>
        )}

        <AssistantShell estado={estado} enviar={enviarTurno} />

        {/* Lo que no depende del proveedor, en la misma pantalla. */}
        <Section title="Pendientes de la casa" hint="Los producen los motores, no la IA">
          <InboxList estado={pendientes} />
        </Section>
      </div>
    </AppShell>
  );
}
