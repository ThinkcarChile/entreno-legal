import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Card, EmptyState, LinkButton } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { cargarEvento, cargarMenu, cargarRevisionVigente } from "../../queries";
import { planDeCompraDelEvento, sobranteDespuesDelRedondeo } from "../../compras/lineas";
import {
  cargarComprasDelEvento,
  cargarLotesNoNeteables,
  comprometidoPorCorte,
} from "../../compras/queries";
import { TableroCompras } from "./TableroCompras";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * /eventos/[id]/compras — §33: qué necesitamos, qué tenemos y qué hay que
 * comprar, con el desglose por corte.
 *
 * Todo lo que se muestra acá sale de DOS fuentes y de ninguna más: la revisión
 * congelada del motor (lo que se calculó, con sus rangos y sus desconocidos) y
 * las líneas que están escritas en la lista de compras (lo que se pidió y lo
 * que ya se compró). No hay un tercer número calculado en la pantalla: si
 * hiciera falta uno, sería un segundo motor de cantidades y tarde o temprano
 * diría algo distinto al primero.
 */
export default async function ComprasDelEventoPage({ params }: Props) {
  const { id } = await params;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/eventos/${id}/compras`);

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="shopping" title="Compras del evento">
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

  const [revision, menu, compras] = await Promise.all([
    cargarRevisionVigente(supabase, id),
    cargarMenu(supabase, id),
    cargarComprasDelEvento(supabase, id),
  ]);

  const cortes = menu
    .map((m) => m.ingredientId)
    .filter((v): v is string => v !== null);
  const noNeteables = await cargarLotesNoNeteables(supabase, householdId, cortes);

  const plan =
    revision === null
      ? null
      : planDeCompraDelEvento({
          eventoId: id,
          titulo: evento.titulo,
          fecha: evento.fecha,
          salida: revision.salida,
          identidades: menu.map((m) => ({
            itemId: m.id,
            ingredientId: m.ingredientId,
            productId: m.productId,
          })),
        });

  // El sobrante REAL: el del motor es "antes de presentación comercial", y lo
  // que se va a comprar de verdad es lo que dicen las líneas de la lista.
  const sobrante =
    revision === null
      ? null
      : sobranteDespuesDelRedondeo(revision.salida, comprometidoPorCorte(compras.lineas));

  return (
    <AppShell active="shopping" title="¿Qué compro?" subtitle={evento.titulo} wide>
      <div className="mt-md space-y-lg">
        {revision === null || plan === null ? (
          <Card className="space-y-md p-md">
            <p className="font-body-md text-body-md text-on-surface">
              Este evento todavía no tiene una estimación calculada, así que no hay nada que
              mandar a la compra.
            </p>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              No quiere decir que no haya que comprar nada: quiere decir que nadie ha calculado
              todavía cuánta carne hace falta.
            </p>
            <LinkButton href={`/eventos/${id}`}>Volver al evento</LinkButton>
          </Card>
        ) : (
          <TableroCompras
            eventoId={id}
            estadoEvento={evento.estado}
            estadoCrudo={evento.estadoCrudo}
            plan={plan}
            compras={compras}
            sobrante={sobrante}
            noNeteables={noNeteables}
          />
        )}
      </div>
    </AppShell>
  );
}
