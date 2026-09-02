import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Card, CardLink, Chip, EmptyState, Icon, LinkButton, Section } from "@/components/ui";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { cargarEventos, type Evento } from "./queries";
import { ETIQUETA_ESTADO, ETIQUETA_TIPO, ICONO_TIPO } from "./vocabulario";
import { diaCivilDelHogar } from "@/app/comi/historia-queries";

export const dynamic = "force-dynamic";

/**
 * /eventos — los asados, cumpleaños y viajes del hogar.
 *
 * La lista se parte en TRES por el tiempo y no por el estado: lo que viene, lo
 * de hoy y lo que ya pasó. Es la pregunta que uno trae cuando abre la pantalla
 * ("¿qué tengo encima?"), y ordenar por estado obliga a leer seis tarjetas para
 * contestarla.
 */

/** Tono del chip de estado. El color acompaña; el texto siempre está. */
function tonoEstado(evento: Evento): "neutro" | "primario" | "atencion" | "peligro" {
  switch (evento.estado) {
    case "CONFIRMED":
    case "IN_PROGRESS":
      return "primario";
    case "DRAFT":
      return "atencion";
    case "CANCELLED":
      return "peligro";
    default:
      return "neutro";
  }
}

function TarjetaEvento({ evento }: { evento: Evento }) {
  return (
    <CardLink href={`/eventos/${evento.id}`} className="block p-md">
      <div className="flex items-start gap-md">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary-fixed text-on-primary-fixed">
          <Icon name={evento.tipo ? ICONO_TIPO[evento.tipo] : "event"} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-headline-sm text-headline-sm text-on-surface">{evento.titulo}</p>
          <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">
            {evento.fecha}
            {evento.horaDeServir ? ` · ${evento.horaDeServir.slice(0, 5)}` : ""} ·{" "}
            {/* Un tipo que esta versión no conoce se muestra con su código: es
                feo, pero no miente diciendo que un matrimonio es "otro". */}
            {evento.tipo ? ETIQUETA_TIPO[evento.tipo] : evento.tipoCrudo}
          </p>
          <div className="mt-sm flex flex-wrap gap-sm">
            <Chip tono={tonoEstado(evento)}>
              {evento.estado ? ETIQUETA_ESTADO[evento.estado] : evento.estadoCrudo}
            </Chip>
            {evento.bloqueadoEn !== null && <Chip icon="lock">Plan bloqueado</Chip>}
            {evento.enCasa === false && <Chip icon="location_on">Fuera de casa</Chip>}
          </div>
        </div>
      </div>
    </CardLink>
  );
}

export default async function EventosPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/eventos");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="plan" title="Eventos">
        <div className="mt-md">
          <EmptyState icon="group_add">
            Primero crea o únete a un hogar en la pestaña Familia.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  // El día es el del HOGAR. Con el día del servidor, un asado de mañana en
  // Santiago aparece como "hoy" desde las 21:00 en UTC.
  const { hoy } = await diaCivilDelHogar(supabase, householdId, new Date());
  const eventos = await cargarEventos(supabase, householdId);

  const deHoy = eventos.filter((e) => e.fecha === hoy);
  const queVienen = eventos.filter((e) => e.fecha > hoy).reverse();
  const pasados = eventos.filter((e) => e.fecha < hoy);

  return (
    <AppShell
      active="plan"
      title="Eventos"
      subtitle="Asados, cumpleaños, viajes"
      action={<LinkButton href="/eventos/nuevo">Nuevo evento</LinkButton>}
    >
      <div className="mt-md space-y-lg">
        {eventos.length === 0 && (
          <EmptyState icon="celebration">
            Todavía no hay eventos. Uno nuevo sirve para calcular cuánta comida comprar y para
            avisarle a la semana que ese día se come distinto.
          </EmptyState>
        )}

        {deHoy.length > 0 && (
          <Section title="Hoy">
            <ul className="space-y-md">
              {deHoy.map((e) => (
                <li key={e.id}>
                  <TarjetaEvento evento={e} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        {queVienen.length > 0 && (
          <Section title="Lo que viene">
            <ul className="space-y-md">
              {queVienen.map((e) => (
                <li key={e.id}>
                  <TarjetaEvento evento={e} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        {pasados.length > 0 && (
          <Section title="Ya pasaron" hint="Sirven para estimar mejor los que vienen.">
            <ul className="space-y-md">
              {pasados.map((e) => (
                <li key={e.id}>
                  <TarjetaEvento evento={e} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Card className="p-md">
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Los eventos no compran ni descuentan nada por su cuenta: la compra sigue pasando por la
            lista y la despensa por los movimientos de siempre.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
