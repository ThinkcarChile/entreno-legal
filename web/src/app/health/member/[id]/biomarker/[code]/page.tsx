import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
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

/**
 * /health/member/[id]/biomarker/[code] (§12/§55): historial y tendencia
 * DESCRIPTIVA. Sin colores alarmistas, sin diagnóstico: fechas, valores,
 * unidades y el rango QUE IMPRIMIÓ el laboratorio.
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

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="health" />
      <h1 className="mb-1 text-xl font-semibold">{definicion.display_name}</h1>
      <p className="mb-4 text-xs text-[var(--ink)]/60">
        Historial confirmado. La tendencia es descriptiva: describe números, no órganos.
      </p>

      {series.length === 0 && (
        <p className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4 text-sm text-[var(--ink)]/60">
          Sin mediciones confirmadas de este biomarcador.
        </p>
      )}

      {series.map((serie) => {
        const puntos = serie.points;
        const min = Math.min(...puntos.map((p) => p.value));
        const max = Math.max(...puntos.map((p) => p.value));
        const rango = max - min || 1;
        const w = 300;
        const alto = 80;
        const paso = puntos.length > 1 ? w / (puntos.length - 1) : 0;
        const y = (v: number) => 10 + (alto - 20) * (1 - (v - min) / rango);
        return (
          <section
            key={serie.unit ?? "sin-unidad"}
            className="mb-4 rounded-2xl border border-[var(--ink)]/10 bg-white p-4"
          >
            <h2 className="text-sm font-semibold">
              Serie en {serie.unit ?? "unidad desconocida"}
              {series.length > 1 && " (las unidades no se mezclan sin conversión validada)"}
            </h2>
            <p className="mt-0.5 text-xs text-[var(--ink)]/60">
              {TENDENCIA[serie.trend]}
              {serie.lastComparison &&
                ` · última medición ${
                  serie.lastComparison === "MAYOR"
                    ? "mayor que la anterior"
                    : serie.lastComparison === "MENOR"
                      ? "menor que la anterior"
                      : "igual a la anterior"
                }`}
            </p>

            {puntos.length > 1 && (
              <svg
                viewBox={`0 0 ${w} ${alto}`}
                className="mt-2 h-20 w-full"
                role="img"
                aria-label={`Evolución de ${definicion.display_name}`}
              >
                <polyline
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-[var(--accent)]"
                  points={puntos.map((p, i) => `${i * paso},${y(p.value)}`).join(" ")}
                />
                {puntos.map((p, i) => (
                  <circle key={p.observationId} cx={i * paso} cy={y(p.value)} r="3" className="fill-[var(--accent)]" />
                ))}
              </svg>
            )}

            <ul className="mt-2 space-y-1 text-sm">
              {[...puntos].reverse().map((p) => {
                const obs = historicas.find((o) => o.id === p.observationId);
                return (
                  <li key={p.observationId} className="flex flex-wrap justify-between gap-2 rounded-lg bg-[var(--paper)] px-2 py-1.5">
                    <span>
                      {p.date} · <strong>{p.value}</strong> {serie.unit ?? "(unidad desconocida)"}
                    </span>
                    <span className="text-xs text-[var(--ink)]/50">
                      {obs?.reference_text ??
                        (obs?.reference_low != null && obs?.reference_high != null
                          ? `rango del lab: ${obs.reference_low}–${obs.reference_high}`
                          : "rango no impreso")}
                      {" · "}
                      {obs?.verification_status === "CONFIRMED" ? "confirmado" : obs?.verification_status}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {historicas.some((o) => o.verification_status === "CORRECTED") && (
        <section className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4 text-sm">
          <h2 className="mb-1 font-semibold">Correcciones</h2>
          <ul className="space-y-1 text-xs text-[var(--ink)]/60">
            {historicas
              .filter((o) => o.verification_status === "CORRECTED")
              .map((o) => (
                <li key={o.id}>
                  {o.collected_date}: {o.value} {o.unit ?? ""} fue corregida — la historia conserva
                  ambas versiones.
                </li>
              ))}
          </ul>
        </section>
      )}
    </main>
  );
}
