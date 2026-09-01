import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { EmptyState, Notice } from "@/components/ui";
import { addDays, dayOfMonth, weekdayName } from "@/domain/nutrition/calendar";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { diaCivilDelHogar } from "./historia-queries";
import { loadDia } from "./queries";
import { ComiBoard } from "./ComiBoard";

export const dynamic = "force-dynamic";

/**
 * /comi — "Lo que comimos".
 *
 * Es la otra mitad de la 0036: desde que servir dejó de declarar consumo, el
 * eje de la REALIDAD no tiene quién lo escriba desde la aplicación. Los RPC de
 * la 0038 existían y nadie fuera de los tests los llamaba; esta pantalla es la
 * mano que los usa.
 *
 * La ruta se llama /comi y no /foodlog porque la app le habla en español a una
 * familia chilena.
 */

interface Props {
  searchParams: Promise<{ dia?: string }>;
}

export default async function ComiPage({ searchParams }: Props) {
  const { dia: diaPedido } = await searchParams;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/comi");

  const { householdId, members } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="plan" title="Lo que comimos">
        <div className="mt-md">
          <EmptyState icon="group_add">
            Primero crea o únete a un hogar en la pestaña Familia.
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  // El día es el del HOGAR, no el del servidor: declarar a las 00:30 la cena de
  // anoche no puede cambiarla de día. Es la misma regla que hace cumplir
  // `app.household_today` del otro lado.
  //
  // Y lo pregunta `diaCivilDelHogar`, que es el ÚNICO dueño de esta pregunta en
  // la pantalla. Acá había una segunda copia que leía el hogar con
  // `.maybeSingle()` y tapaba con un `??` la zona que no se pudo leer. Ese `??`
  // no era un respaldo: `.maybeSingle()` devuelve null también cuando la RLS no
  // dejó ver la fila, así que un "no se pudo leer" se convertía en un valor
  // concreto sin decirle nada a nadie. De ese día civil cuelga TODO lo que hace
  // esta pantalla —qué día se declara, qué es hoy y qué es ayer, y el tope que
  // impide pedir el futuro—, así que si no se puede saber, revienta. El respaldo
  // para la zona EN BLANCO sigue existiendo donde corresponde
  // (`DEFAULT_TIME_ZONE`), y no escrito a mano acá.
  const { hoy } = await diaCivilDelHogar(supabase, householdId, new Date());
  const ayer = addDays(hoy, -1);

  // Un día futuro no se acepta: nadie declara lo que todavía no comió, y el RPC
  // lo rebota igual. Mejor caer en hoy que mostrar una pantalla que no puede
  // guardar nada.
  const pedido = diaPedido && /^\d{4}-\d{2}-\d{2}$/.test(diaPedido) ? diaPedido : hoy;
  const dia = pedido > hoy ? hoy : pedido;

  const { porDeclarar, declarado } = await loadDia(supabase, householdId, dia);

  const pendientes = porDeclarar.length;
  const subtitulo =
    dia === hoy
      ? "Hoy"
      : `${weekdayName(dia)} ${dayOfMonth(dia)}${dia === ayer ? " (ayer)" : ""}`;

  return (
    <AppShell
      active="plan"
      title="Lo que comimos"
      subtitle={
        pendientes === 0
          ? subtitulo
          : `${subtitulo} · ${pendientes} ${pendientes === 1 ? "porción" : "porciones"} sin anotar`
      }
    >
      <div className="mt-md space-y-lg">
        {declarado.length === 0 && porDeclarar.length === 0 && (
          <Notice icon="info">
            Acá se anota lo que se comió de verdad. No mueve la despensa: eso ya lo hizo servir la
            comida.
          </Notice>
        )}

        <ComiBoard
          dia={dia}
          hoy={hoy}
          ayer={ayer}
          porDeclarar={porDeclarar}
          declarado={declarado}
          miembros={members.map((m) => ({ id: m.id, nombre: m.displayName }))}
          miMiembroId={members.find((m) => m.isMe)?.id ?? null}
        />
      </div>
    </AppShell>
  );
}
