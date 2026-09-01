import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Card, Chip, Icon, LinkButton, Notice, Section } from "@/components/ui";
import { createSupabaseServer } from "@/lib/supabase/server";
import { avance, derivarPasos, onboardingListo, proximoPaso } from "./pasos";
import type { EstadoPaso, PasoOnboarding } from "./pasos";
import { cargarHechosOnboarding } from "./queries";

export const dynamic = "force-dynamic";

/**
 * Primeros pasos: la pantalla que faltaba entre "me creé una cuenta" y "tengo la
 * semana planificada".
 *
 * Antes, quien llegaba de cero caía en un redirect y en un formulario suelto de
 * crear hogar, sin saber que después venían integrantes, perfiles, invitaciones
 * y plan. Acá está el orden completo, y cada paso lleva a la pantalla que YA
 * existe: esta página no tiene ni un formulario propio, así que no hay dos
 * lugares donde crear un hogar ni dos que se puedan desincronizar.
 *
 * Se puede abandonar en cualquier momento —la barra de abajo sigue funcionando—
 * y se vuelve tocando Inicio, que apunta acá mientras quede algo esencial por
 * hacer. Nadie llena cinco pantallas de una sentada.
 *
 * Cuando lo esencial ya está, Inicio deja en el hogar y esta pantalla deja de
 * aparecer sola. El aviso de "listo" decía que se podía volver acá "cuando
 * quieras" y era falso: no había un solo enlace a /onboarding en toda la
 * interfaz. Ahora el aviso dice lo que de verdad pasa —Inicio trae de vuelta
 * solo si algo esencial se abre otra vez— y manda a los pasos que quedan por su
 * propio destino del menú, que es donde se hacen.
 */
export default async function OnboardingPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/onboarding");

  const pasos = derivarPasos(await cargarHechosOnboarding(supabase));
  const { listos, total, sinRespuesta } = avance(pasos);
  const siguiente = proximoPaso(pasos);
  const listo = onboardingListo(pasos);

  return (
    <AppShell
      active="home"
      title="Primeros pasos"
      subtitle="Cinco pasos para dejar la mesa andando. Puedes hacerlos de a poco."
    >
      <div className="mt-md space-y-md">
        <Card className="p-md">
          <div className="flex flex-wrap items-baseline justify-between gap-sm">
            <p className="font-headline-sm text-headline-sm text-on-surface">
              Vas {listos} de {total}
            </p>
            {siguiente ? (
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                Sigue: {siguiente.titulo.toLocaleLowerCase("es-CL")}
              </p>
            ) : null}
          </div>

          {/* Barra de avance decorativa: el número de arriba ya lo dice con
              palabras, así que acá no hay nada que un lector de pantalla deba
              volver a leer. */}
          <div className="mt-sm h-2 w-full overflow-hidden rounded-full bg-surface-container" aria-hidden>
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${Math.round((listos / total) * 100)}%` }}
            />
          </div>

          <p className="mt-sm font-body-sm text-body-sm text-on-surface-variant">
            Esta pantalla no lleva una lista aparte: mira tus datos cada vez que la abres, así que
            nunca te va a pedir algo que ya hiciste.
            {sinRespuesta > 0
              ? ` ${sinRespuesta === 1 ? "Hay uno" : `Hay ${sinRespuesta}`} que la aplicación no puede dar por hecho sola; ${sinRespuesta === 1 ? "queda marcado" : "quedan marcados"} y te explicamos por qué.`
              : ""}
          </p>
        </Card>

        {listo ? (
          <Notice icon="check_circle" tono="info">
            <p className="font-semibold">Lo esencial ya está</p>
            <p className="mt-1">
              De ahora en adelante Inicio te deja directo en tu hogar. Si más adelante se abre algo
              esencial —agregas a alguien y falta declarar su perfil, por ejemplo—, Inicio te trae de
              vuelta acá solo. Lo que quede pendiente de esta lista se hace en Familia y en Semana,
              que están en el menú.
            </p>
          </Notice>
        ) : null}
      </div>

      <Section title="El camino" hint="En este orden es más fácil, pero puedes saltarte pasos.">
        <ol className="space-y-sm">
          {pasos.map((paso) => (
            <PasoCard key={paso.clave} paso={paso} destacado={paso.clave === siguiente?.clave} />
          ))}
        </ol>
      </Section>

      <div className="flex justify-center">
        <LinkButton href="/family" variant="outline">
          <Icon name="group" className="text-[18px]" />
          Ir a mi hogar
        </LinkButton>
      </div>
    </AppShell>
  );
}

/** El chip lleva SIEMPRE texto: el color acompaña, nunca comunica solo (§94). */
function ChipEstado({ estado }: { estado: EstadoPaso }) {
  if (estado === "LISTO") {
    return (
      <Chip tono="primario" icon="check_circle">
        listo
      </Chip>
    );
  }
  if (estado === "NO_SE_SABE") {
    // Ni listo ni pendiente: no lo pudimos mirar. Se dice, no se rellena.
    return (
      <Chip tono="info" icon="help">
        no se sabe
      </Chip>
    );
  }
  return <Chip icon="radio_button_unchecked">pendiente</Chip>;
}

function PasoCard({ paso, destacado }: { paso: PasoOnboarding; destacado: boolean }) {
  const hecho = paso.estado === "LISTO";
  return (
    <Card as="li" className={`p-md ${destacado ? "ring-2 ring-primary-fixed" : ""}`}>
      <div className="flex items-start gap-md">
        {/* El número va en el título, no acá: este círculo es decoración y el
            lector de pantalla ya lee "1." en el encabezado. */}
        <span
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${
            hecho
              ? "bg-primary-fixed text-on-primary-fixed"
              : paso.disponible
                ? "bg-surface-container text-primary"
                : "bg-surface-container text-outline"
          }`}
          aria-hidden
        >
          <Icon name={hecho ? "check" : paso.icono} className="text-[24px]" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-sm">
            <h4 className="font-headline-sm text-headline-sm text-on-surface">
              {paso.numero}. {paso.titulo}
            </h4>
            <ChipEstado estado={paso.estado} />
          </div>

          <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">{paso.porQue}</p>
          <p className="mt-sm font-body-md text-body-md text-on-surface">{paso.detalle}</p>

          <div className="mt-md">
            {paso.disponible ? (
              <LinkButton href={paso.destino} variant={destacado ? "filled" : "outline"}>
                {paso.accion}
                <Icon name="arrow_forward" className="text-[18px]" />
              </LinkButton>
            ) : (
              <p className="font-body-sm text-body-sm text-outline">
                Se activa cuando termines el paso 1.
              </p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
