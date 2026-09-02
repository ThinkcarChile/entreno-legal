import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Card, EmptyState, LinkButton } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { cargarEvento, cargarRevisionVigente } from "../../queries";
import { PanelEstimacion } from "./PanelEstimacion";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * /eventos/[id]/estimacion — cuánta carne, y por qué esa cantidad.
 *
 * Muestra la REVISIÓN CONGELADA, no un cálculo al vuelo. Si mañana cambia la
 * política del motor, este número sigue siendo el que se usó para comprar: la
 * historia de un evento no se reescribe sola.
 */
export default async function EstimacionPage({ params }: Props) {
  const { id } = await params;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/eventos/${id}/estimacion`);

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="plan" title="Estimación">
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

  const revision = await cargarRevisionVigente(supabase, id);

  return (
    <AppShell active="plan" title="¿Cuánto compro?" subtitle={evento.titulo} wide>
      <div className="mt-md space-y-lg">
        {revision === null ? (
          <Card className="space-y-md p-md">
            {/* Sin estimación NO es una estimación de cero. Se dice con esas
                palabras y se ofrece la única salida útil: ir a calcular. */}
            <p className="font-body-md text-body-md text-on-surface">
              Este evento todavía no tiene una estimación calculada.
            </p>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              No quiere decir que no haya que comprar nada: quiere decir que nadie ha calculado
              todavía. Vuelve al evento, revisa quiénes vienen y qué se come, y aprieta calcular.
            </p>
            <LinkButton href={`/eventos/${id}`}>Volver al evento</LinkButton>
          </Card>
        ) : (
          <PanelEstimacion eventoId={id} revision={revision} />
        )}
      </div>
    </AppShell>
  );
}
