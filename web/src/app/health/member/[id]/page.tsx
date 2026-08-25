import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import { uuidParam } from "@/lib/route-params";
import { labRecency } from "@/domain/clinical/engine";
import { nutritionDataConfidence } from "@/domain/clinical/confidence";
import { effectiveDate } from "@/domain/nutrition/calendar";
import {
  loadAccessibleMembers,
  loadBiomarkers,
  loadConfirmedObservations,
  loadConfirmedRestrictions,
  loadDocuments,
  loadGrants,
  loadImpactReviews,
  loadRestrictions,
  loadScheduleInputs,
  loadSchedules,
} from "../../queries";
import { MemberHealthActions } from "./MemberHealthActions";

export const dynamic = "force-dynamic";

const SEVERIDAD: Record<string, string> = {
  INFO: "informativa",
  CAUTION: "precaución",
  HARD: "estricta",
  CRITICAL_REVIEW: "revisión crítica",
};

const VIGENCIA: Record<string, string> = {
  CURRENT: "vigente",
  EXPIRING_SOON: "vence pronto",
  OUTDATED: "vencido",
  MISSING: "sin resultado",
  NO_SCHEDULE_CONFIGURED: "sin frecuencia configurada",
};

/**
 * /health/member/[id] (§52): resumen, exámenes, biomarcadores, restricciones
 * (SEPARADAS de preferencias, §56), frecuencias, impactos y permisos.
 * RLS decide qué llega; la página muestra lo que llega.
 */
export default async function MemberHealthPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/health");

  const { id: idCrudo } = await params;
  const memberId = uuidParam(idCrudo);

  const accesibles = await loadAccessibleMembers(supabase);
  const miembro = accesibles.find((m) => m.id === memberId);
  if (!miembro) redirect("/health");

  const [documentos, observaciones, restricciones, schedules, biomarcadores, impactos, grants,
    obsConfirmadas, restConfirmadas, scheduleInputs] = await Promise.all([
    loadDocuments(supabase, memberId),
    loadConfirmedObservations(supabase, memberId),
    loadRestrictions(supabase, memberId),
    loadSchedules(supabase, memberId),
    loadBiomarkers(supabase),
    loadImpactReviews(supabase, memberId),
    loadGrants(supabase, memberId),
    loadConfirmedObservations(supabase, memberId),
    loadConfirmedRestrictions(supabase, memberId),
    loadScheduleInputs(supabase, memberId),
  ]);

  const hoy = effectiveDate(new Date(), "America/Santiago");
  const porCodigo = new Map(biomarcadores.map((b) => [b.code, b]));
  const codigosConDatos = [...new Set(observaciones.map((o) => o.biomarkerCode))];

  const confianza = nutritionDataConfidence({
    date: hoy,
    restrictions: restConfirmadas,
    observations: obsConfirmadas,
    schedules: scheduleInputs,
    unverifiedObservationCount: documentos.filter((d) =>
      ["NEEDS_REVIEW", "EXTRACTED"].includes(d.processing_status),
    ).length,
    pendingImpactReviews: impactos.length,
  });

  const activas = restricciones.filter((r) => r.verification_status === "CONFIRMED");
  const otras = restricciones.filter((r) => r.verification_status !== "CONFIRMED");

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="health" />
      <header className="mb-4">
        <h1 className="text-xl font-semibold">{miembro.displayName}</h1>
        <p className="text-xs text-[var(--ink)]/60">
          Confianza de los datos para personalizar:{" "}
          <strong>
            {confianza.level === "HIGH" ? "alta" : confianza.level === "MEDIUM" ? "media" : "baja"}
          </strong>{" "}
          — habla de NUESTROS datos, no de la salud de nadie.
        </p>
        <ul className="mt-1 space-y-0.5 text-[11px] text-[var(--ink)]/50">
          {confianza.reasons.map((r) => (
            <li key={r.code}>· {r.text}</li>
          ))}
        </ul>
      </header>

      {impactos.length > 0 && (
        <section className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm">
          <h2 className="font-semibold text-amber-900">Impactos pendientes</h2>
          <p className="mt-1 text-xs text-amber-900/80">
            Cambió información clínica. Nada se aplicó: revisa y decide.
          </p>
          <MemberHealthActions impactos={impactos.map((i) => ({ id: i.id, trigger: i.trigger_kind }))} />
        </section>
      )}

      <section className="mb-4">
        <h2 className="mb-2 text-sm font-semibold">Biomarcadores con datos confirmados</h2>
        {codigosConDatos.length === 0 ? (
          <p className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4 text-sm text-[var(--ink)]/60">
            Sin observaciones confirmadas todavía. Sube un examen y confírmalo.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {codigosConDatos.map((code) => {
              const vigencia = labRecency(code, hoy, obsConfirmadas, scheduleInputs);
              const ultima = obsConfirmadas
                .filter((o) => o.biomarkerCode === code)
                .sort((a, b) => ((a.collectedDate ?? "") < (b.collectedDate ?? "") ? 1 : -1))[0];
              return (
                <li key={code}>
                  <Link
                    href={`/health/member/${memberId}/biomarker/${code}`}
                    className="block rounded-2xl border border-[var(--ink)]/10 bg-white p-3 text-sm"
                  >
                    <span className="font-medium">{porCodigo.get(code)?.display_name ?? code}</span>
                    <span className="mt-1 block text-xs text-[var(--ink)]/60">
                      {ultima ? `${ultima.value} ${ultima.unit ?? "(unidad desconocida)"}` : "—"} ·{" "}
                      {VIGENCIA[vigencia.status]}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mb-4">
        <h2 className="mb-2 text-sm font-semibold">Restricciones clínicas</h2>
        <p className="mb-2 text-[11px] text-[var(--ink)]/50">
          Separadas de las preferencias de comida a propósito: una preferencia se cambia con un
          clic; una restricción clínica exige fuente, confirmación y flujo clínico.
        </p>
        {activas.length === 0 && otras.length === 0 ? (
          <p className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4 text-sm text-[var(--ink)]/60">
            Sin restricciones registradas. Tener una condición NO crea límites: los límites nacen
            de una regla confirmada con fuente.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {[...activas, ...otras].map((r) => (
              <li key={r.id} className="rounded-2xl border border-[var(--ink)]/10 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">
                    {r.type} · {r.target}
                    {r.value !== null && ` ${r.value} ${r.unit ?? ""}`}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                      r.verification_status === "CONFIRMED"
                        ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                        : "bg-[var(--ink)]/10 text-[var(--ink)]/60"
                    }`}
                  >
                    {r.verification_status === "CONFIRMED"
                      ? "confirmada"
                      : r.verification_status === "RETIRED"
                        ? "retirada"
                        : "sin confirmar"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[var(--ink)]/60">
                  severidad {SEVERIDAD[r.severity] ?? r.severity} · fuente {r.source}
                  {r.source_reference && ` (${r.source_reference})`} · vigente desde {r.valid_from}
                  {r.valid_until && ` hasta ${r.valid_until}`}
                  {r.confirmed_at && ` · confirmada ${r.confirmed_at.slice(0, 10)}`}
                </p>
                {r.reason && <p className="mt-1 text-xs text-[var(--ink)]/50">{r.reason}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-4">
        <h2 className="mb-2 text-sm font-semibold">Próximos exámenes</h2>
        {schedules.length === 0 ? (
          <p className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4 text-sm text-[var(--ink)]/60">
            Sin frecuencia configurada. La app no inventa "cada 3 meses": la frecuencia la define
            tu médico, nutricionista o tú.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {schedules.map((s) => (
              <li key={s.id} className="rounded-xl border border-[var(--ink)]/10 bg-white px-3 py-2">
                {s.biomarker_id
                  ? (biomarcadores.find((b) => b.id === s.biomarker_id)?.display_name ?? "Biomarcador")
                  : s.panel_label}{" "}
                · cada {s.expected_interval_days} días · definido por {s.source}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-4">
        <h2 className="mb-2 text-sm font-semibold">Exámenes</h2>
        <ul className="space-y-1 text-sm">
          {documentos.map((d) => (
            <li key={d.id}>
              <Link
                href={`/health/exams/${d.id}/review`}
                className="block rounded-xl border border-[var(--ink)]/10 bg-white px-3 py-2"
              >
                {d.source_lab_name ?? "Examen"} · {d.document_date ?? "sin fecha"} ·{" "}
                {d.processing_status}
              </Link>
            </li>
          ))}
          {documentos.length === 0 && (
            <li className="text-xs text-[var(--ink)]/50">Sin exámenes.</li>
          )}
        </ul>
      </section>

      {miembro.relation !== "GRANTED" && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Quién puede ver estos datos</h2>
          <p className="mb-2 text-[11px] text-[var(--ink)]/50">
            Los roles del hogar NO dan acceso a datos médicos: solo estos permisos explícitos.
          </p>
          {grants.length === 0 ? (
            <p className="rounded-xl border border-[var(--ink)]/10 bg-white px-3 py-2 text-sm text-[var(--ink)]/60">
              Nadie más: solo {miembro.relation === "SELF" ? "tú" : "su tutor"}.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {grants.map((g) => (
                <li key={g.id} className="rounded-xl border border-[var(--ink)]/10 bg-white px-3 py-2">
                  {g.permission} → integrante {g.grantee_member_id.slice(0, 8)}…
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
