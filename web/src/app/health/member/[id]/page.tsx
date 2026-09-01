import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import {
  Card,
  CardLink,
  Chip,
  EmptyState,
  Icon,
  LinkButton,
  Notice,
  Section,
  type Tono,
} from "@/components/ui";
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
  loadConditions,
  loadScheduleInputs,
  loadSchedules,
} from "../../queries";
import { MemberHealthActions } from "./MemberHealthActions";
import { ConditionsPanel } from "./ConditionsPanel";

export const dynamic = "force-dynamic";

const SEVERIDAD: Record<string, string> = {
  INFO: "informativa",
  CAUTION: "precaución",
  HARD: "estricta",
  CRITICAL_REVIEW: "revisión crítica",
};

/**
 * Vigencia del dato, NO de la salud: habla de cuán fresco está el resultado
 * frente a la frecuencia configurada. Por eso puede llevar color; los valores
 * de los exámenes nunca lo llevan (§12: sin colores alarmistas).
 */
const VIGENCIA: Record<string, { texto: string; tono: Tono }> = {
  CURRENT: { texto: "vigente", tono: "primario" },
  EXPIRING_SOON: { texto: "vence pronto", tono: "atencion" },
  OUTDATED: { texto: "vencido", tono: "peligro" },
  MISSING: { texto: "sin resultado", tono: "neutro" },
  NO_SCHEDULE_CONFIGURED: { texto: "sin frecuencia configurada", tono: "neutro" },
};

const CONFIANZA: Record<string, { texto: string; tono: Tono }> = {
  HIGH: { texto: "alta", tono: "primario" },
  MEDIUM: { texto: "media", tono: "atencion" },
  LOW: { texto: "baja", tono: "neutro" },
};

const ESTADO_EXAMEN: Record<string, { texto: string; tono: Tono }> = {
  UPLOADED: { texto: "subido", tono: "neutro" },
  PROCESSING: { texto: "procesando", tono: "neutro" },
  EXTRACTED: { texto: "por revisar", tono: "atencion" },
  NEEDS_REVIEW: { texto: "por revisar", tono: "atencion" },
  CONFIRMED: { texto: "confirmado", tono: "primario" },
  FAILED: { texto: "no se pudo leer", tono: "peligro" },
  ARCHIVED: { texto: "archivado", tono: "neutro" },
};

const VERIFICACION: Record<string, { texto: string; tono: Tono }> = {
  CONFIRMED: { texto: "confirmada", tono: "primario" },
  RETIRED: { texto: "retirada", tono: "neutro" },
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
    obsConfirmadas, restConfirmadas, scheduleInputs, condiciones] = await Promise.all([
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
    loadConditions(supabase, memberId),
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
  const nivel = CONFIANZA[confianza.level] ?? { texto: "baja", tono: "neutro" as const };

  return (
    <AppShell
      active="health"
      title={miembro.displayName}
      subtitle="Exámenes, biomarcadores confirmados y restricciones verificadas de esta persona."
      action={
        <LinkButton href="/health" variant="outline">
          <Icon name="arrow_back" className="text-[18px]" />
          Salud
        </LinkButton>
      }
    >
      <Section className="mt-md">
        <Card className="p-md">
          <div className="flex flex-wrap items-center justify-between gap-sm">
            <h2 className="flex items-center gap-sm font-headline-sm text-headline-sm text-on-surface">
              <Icon name="fact_check" className="shrink-0 text-primary" />
              Confianza de los datos
            </h2>
            <Chip tono={nivel.tono}>confianza {nivel.texto}</Chip>
          </div>
          <p className="mt-sm font-body-sm text-body-sm text-on-surface-variant">
            Habla de <strong>nuestros</strong> datos para personalizar, no de la salud de nadie.
          </p>
          <ul className="mt-sm space-y-1">
            {confianza.reasons.map((r) => (
              <li
                key={r.code}
                className="flex items-start gap-sm font-body-sm text-body-sm text-on-surface-variant"
              >
                <Icon name="chevron_right" className="mt-0.5 shrink-0 text-[16px] text-outline" />
                <span className="min-w-0">{r.text}</span>
              </li>
            ))}
          </ul>
        </Card>
      </Section>

      {impactos.length > 0 && (
        <Section>
          <Notice icon="pending_actions">
            <p className="font-semibold">Impactos pendientes</p>
            <p className="mt-0.5">Cambió información clínica. Nada se aplicó: revisa y decide.</p>
            <MemberHealthActions
              impactos={impactos.map((i) => ({ id: i.id, trigger: i.trigger_kind }))}
            />
          </Notice>
        </Section>
      )}

      <Section title="Biomarcadores con datos confirmados">
        {codigosConDatos.length === 0 ? (
          <EmptyState icon="science">
            Sin observaciones confirmadas todavía. Sube un examen y confírmalo.
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-1 gap-sm sm:grid-cols-2">
            {codigosConDatos.map((code) => {
              const vigencia = labRecency(code, hoy, obsConfirmadas, scheduleInputs);
              const estado = VIGENCIA[vigencia.status] ?? {
                texto: vigencia.status,
                tono: "neutro" as const,
              };
              const ultima = obsConfirmadas
                .filter((o) => o.biomarkerCode === code)
                .sort((a, b) => ((a.collectedDate ?? "") < (b.collectedDate ?? "") ? 1 : -1))[0];
              return (
                <li key={code}>
                  <CardLink
                    href={`/health/member/${memberId}/biomarker/${code}`}
                    className="flex h-full items-center gap-md p-md"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-body-md text-body-md font-semibold text-on-surface">
                        {porCodigo.get(code)?.display_name ?? code}
                      </span>
                      <span className="mt-0.5 block font-body-sm text-body-sm text-on-surface-variant">
                        {ultima ? `${ultima.value} ${ultima.unit ?? "(unidad desconocida)"}` : "—"}
                      </span>
                      <span className="mt-1 block">
                        <Chip tono={estado.tono}>{estado.texto}</Chip>
                      </span>
                    </span>
                    <Icon name="chevron_right" className="shrink-0 text-outline" />
                  </CardLink>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title="Restricciones clínicas"
        hint="Separadas de las preferencias de comida a propósito: una preferencia se cambia con un clic; una restricción clínica exige fuente, confirmación y flujo clínico."
      >
        {activas.length === 0 && otras.length === 0 ? (
          <EmptyState icon="health_and_safety">
            Sin restricciones registradas. Tener una condición NO crea límites: los límites nacen
            de una regla confirmada con fuente.
          </EmptyState>
        ) : (
          <ul className="space-y-sm">
            {[...activas, ...otras].map((r) => {
              const verificacion = VERIFICACION[r.verification_status] ?? {
                texto: "sin confirmar",
                tono: "neutro" as const,
              };
              return (
                <li key={r.id}>
                  <Card className="p-md">
                    <div className="flex flex-wrap items-start justify-between gap-sm">
                      <span className="min-w-0 font-body-md text-body-md font-semibold text-on-surface">
                        {r.type} · {r.target}
                        {r.value !== null && ` ${r.value} ${r.unit ?? ""}`}
                      </span>
                      <Chip tono={verificacion.tono}>{verificacion.texto}</Chip>
                    </div>
                    <p className="mt-sm font-body-sm text-body-sm text-on-surface-variant">
                      severidad {SEVERIDAD[r.severity] ?? r.severity} · fuente {r.source}
                      {r.source_reference && ` (${r.source_reference})`} · vigente desde{" "}
                      {r.valid_from}
                      {r.valid_until && ` hasta ${r.valid_until}`}
                      {r.confirmed_at && ` · confirmada ${r.confirmed_at.slice(0, 10)}`}
                    </p>
                    {r.reason && (
                      <p className="mt-1 font-body-sm text-body-sm text-outline">{r.reason}</p>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Próximos exámenes">
        {schedules.length === 0 ? (
          <EmptyState icon="event_busy">
            Sin frecuencia configurada. La app no inventa &ldquo;cada 3 meses&rdquo;: la frecuencia
            la define tu médico, nutricionista o tú.
          </EmptyState>
        ) : (
          <Card className="p-md">
            <ul>
              {schedules.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-md gap-y-1 border-b border-outline-variant/40 py-sm last:border-0"
                >
                  <span className="font-body-md text-body-md text-on-surface">
                    {s.biomarker_id
                      ? (biomarcadores.find((b) => b.id === s.biomarker_id)?.display_name ??
                        "Biomarcador")
                      : s.panel_label}
                  </span>
                  <span className="font-body-sm text-body-sm text-on-surface-variant">
                    cada {s.expected_interval_days} días · definido por {s.source}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </Section>

      <Section title="Exámenes">
        {documentos.length === 0 ? (
          <EmptyState icon="description">Sin exámenes.</EmptyState>
        ) : (
          <ul className="space-y-sm">
            {documentos.map((d) => {
              const estado = ESTADO_EXAMEN[d.processing_status] ?? {
                texto: d.processing_status,
                tono: "neutro" as const,
              };
              return (
                <li key={d.id}>
                  <CardLink
                    href={`/health/exams/${d.id}/review`}
                    className="flex items-center justify-between gap-md p-md"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-body-md text-body-md text-on-surface">
                        {d.source_lab_name ?? "Examen"}
                      </span>
                      <span className="block font-body-sm text-body-sm text-on-surface-variant">
                        {d.document_date ?? "sin fecha"}
                      </span>
                    </span>
                    <Chip tono={estado.tono}>{estado.texto}</Chip>
                  </CardLink>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title="Condiciones declaradas"
        hint="Contexto de salud, no límites: declarar una condición no cambia el plan ni filtra recetas. Los límites nacen de las restricciones confirmadas, más arriba."
      >
        <ConditionsPanel
          memberId={memberId}
          /* GRANTED puede MIRAR por permiso explícito; escribir la ficha médica
             ajena es de SELF o del tutor, igual que en el resto del módulo. La
             RLS lo exige de todas formas: esto solo evita ofrecer un botón que
             va a rebotar. */
          puedeEscribir={miembro.relation !== "GRANTED"}
          condiciones={condiciones}
        />
      </Section>

      {miembro.relation !== "GRANTED" && (
        <Section
          title="Quién puede ver estos datos"
          hint="Los roles del hogar NO dan acceso a datos médicos: solo estos permisos explícitos."
        >
          {grants.length === 0 ? (
            <EmptyState icon="lock">
              Nadie más: solo {miembro.relation === "SELF" ? "tú" : "su tutor"}.
            </EmptyState>
          ) : (
            <Card className="p-md">
              <ul>
                {grants.map((g) => (
                  <li
                    key={g.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-md gap-y-1 border-b border-outline-variant/40 py-sm last:border-0"
                  >
                    <span className="font-body-md text-body-md text-on-surface">{g.permission}</span>
                    <span className="font-body-sm text-body-sm text-on-surface-variant">
                      integrante {g.grantee_member_id.slice(0, 8)}…
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </Section>
      )}

    </AppShell>
  );
}
