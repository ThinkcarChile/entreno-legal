import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Card, Chip, EmptyState, Icon, LinkButton, Section } from "@/components/ui";
import { uuidParam } from "@/lib/route-params";
import { biomarkerSeries } from "@/domain/clinical/trends";
import {
  loadAccessibleMembers,
  loadBiomarkers,
  loadConfirmedObservations,
  loadObservations,
} from "../../../../queries";

export const dynamic = "force-dynamic";

const TENDENCIA: Record<string, string> = {
  ASCENDENTE: "tendencia ascendente",
  DESCENDENTE: "tendencia descendente",
  ESTABLE: "sin dirección clara",
  SIN_TENDENCIA: "muy pocas mediciones para hablar de tendencia",
};

/** Icono de la tendencia. Descriptivo: la flecha dice qué hizo el número. */
const ICONO_TENDENCIA: Record<string, string> = {
  ASCENDENTE: "trending_up",
  DESCENDENTE: "trending_down",
  ESTABLE: "trending_flat",
  SIN_TENDENCIA: "help",
};

const COMPARACION: Record<string, string> = {
  MAYOR: "mayor que la anterior",
  MENOR: "menor que la anterior",
  IGUAL: "igual a la anterior",
};

/**
 * /health/member/[id]/biomarker/[code] (§12/§55): historial y tendencia
 * DESCRIPTIVA. Sin colores alarmistas, sin diagnóstico: fechas, valores,
 * unidades y el rango QUE IMPRIMIÓ el laboratorio.
 *
 * Por eso acá los valores NUNCA se pintan de rojo ni de verde: la app no
 * juzga si un número está "bien". El color se reserva para el estado del
 * dato (confirmado, corregido), nunca para el resultado.
 */
export default async function BiomarkerDetailPage({
  params,
}: {
  params: Promise<{ id: string; code: string }>;
}) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/health");

  const { id: idCrudo, code } = await params;
  const memberId = uuidParam(idCrudo);
  if (!/^[a-z0-9_]{2,40}$/.test(code)) notFound();

  const accesibles = await loadAccessibleMembers(supabase);
  if (!accesibles.some((m) => m.id === memberId)) redirect("/health");

  const [biomarcadores, confirmadas, todas] = await Promise.all([
    loadBiomarkers(supabase),
    loadConfirmedObservations(supabase, memberId),
    loadObservations(supabase, memberId),
  ]);
  const definicion = biomarcadores.find((b) => b.code === code);
  if (!definicion) notFound();

  const series = biomarkerSeries(confirmadas, code);
  const historicas = todas.filter((o) => o.biomarker_id === definicion.id);
  const corregidas = historicas.filter((o) => o.verification_status === "CORRECTED");

  return (
    <AppShell
      active="health"
      title={definicion.display_name}
      subtitle="Historial confirmado. La tendencia es descriptiva: describe números, no órganos."
      action={
        <LinkButton href={`/health/member/${memberId}`} variant="outline">
          <Icon name="arrow_back" className="text-[18px]" />
          Volver
        </LinkButton>
      }
    >
      {series.length === 0 && (
        <Section className="mt-md">
          <EmptyState icon="science">
            Sin mediciones confirmadas de este biomarcador.
          </EmptyState>
        </Section>
      )}

      {series.map((serie, indice) => {
        const puntos = serie.points;
        const min = Math.min(...puntos.map((p) => p.value));
        const max = Math.max(...puntos.map((p) => p.value));
        const rango = max - min || 1;
        const w = 300;
        const alto = 80;
        const paso = puntos.length > 1 ? w / (puntos.length - 1) : 0;
        const y = (v: number) => 10 + (alto - 20) * (1 - (v - min) / rango);
        return (
          <Section key={serie.unit ?? "sin-unidad"} className={indice === 0 ? "mt-md" : ""}>
            <Card className="p-md">
              <div className="flex flex-wrap items-start justify-between gap-sm">
                <h2 className="min-w-0 font-headline-sm text-headline-sm text-on-surface">
                  Serie en {serie.unit ?? "unidad desconocida"}
                </h2>
                <Chip tono="neutro" icon={ICONO_TENDENCIA[serie.trend] ?? "help"}>
                  {TENDENCIA[serie.trend] ?? serie.trend}
                </Chip>
              </div>

              {series.length > 1 && (
                <p className="mt-sm font-body-sm text-body-sm text-on-surface-variant">
                  Las unidades no se mezclan sin conversión validada: cada una es su propia serie.
                </p>
              )}

              {serie.lastComparison && (
                <p className="mt-sm font-body-sm text-body-sm text-on-surface-variant">
                  Última medición {COMPARACION[serie.lastComparison] ?? serie.lastComparison}.
                </p>
              )}

              {puntos.length > 1 && (
                <div className="mt-md rounded-2xl bg-surface-container-low p-md">
                  <svg
                    viewBox={`0 0 ${w} ${alto}`}
                    className="h-20 w-full overflow-visible"
                    role="img"
                    aria-label={`Evolución de ${definicion.display_name}`}
                  >
                    <polyline
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-primary"
                      points={puntos.map((p, i) => `${i * paso},${y(p.value)}`).join(" ")}
                    />
                    {puntos.map((p, i) => (
                      <circle
                        key={p.observationId}
                        cx={i * paso}
                        cy={y(p.value)}
                        r="3.5"
                        strokeWidth="2"
                        className="fill-surface-container-lowest stroke-primary"
                      />
                    ))}
                  </svg>
                  <p className="mt-sm flex justify-between font-label-md text-label-md text-on-surface-variant">
                    <span>
                      mín {min} {serie.unit ?? ""}
                    </span>
                    <span>
                      máx {max} {serie.unit ?? ""}
                    </span>
                  </p>
                </div>
              )}

              <ul className="mt-md">
                {[...puntos].reverse().map((p) => {
                  const obs = historicas.find((o) => o.id === p.observationId);
                  return (
                    <li
                      key={p.observationId}
                      className="flex flex-wrap items-baseline justify-between gap-x-md gap-y-1 border-b border-outline-variant/40 py-sm last:border-0"
                    >
                      <span className="font-body-md text-body-md text-on-surface">
                        {p.date} · <strong>{p.value}</strong>{" "}
                        {serie.unit ?? "(unidad desconocida)"}
                      </span>
                      <span className="font-body-sm text-body-sm text-on-surface-variant">
                        {obs?.reference_text ??
                          (obs?.reference_low != null && obs?.reference_high != null
                            ? `rango del lab: ${obs.reference_low}–${obs.reference_high}`
                            : "rango no impreso")}
                        {" · "}
                        {obs?.verification_status === "CONFIRMED"
                          ? "confirmado"
                          : obs?.verification_status}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </Section>
        );
      })}

      {corregidas.length > 0 && (
        <Section title="Correcciones">
          <Card className="p-md">
            <ul className="space-y-sm">
              {corregidas.map((o) => (
                <li
                  key={o.id}
                  className="flex items-start gap-sm font-body-sm text-body-sm text-on-surface-variant"
                >
                  <Icon name="history" className="mt-0.5 shrink-0 text-[18px] text-outline" />
                  <span className="min-w-0">
                    {o.collected_date}: {o.value} {o.unit ?? ""} fue corregida — la historia
                    conserva ambas versiones.
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      )}
    </AppShell>
  );
}
