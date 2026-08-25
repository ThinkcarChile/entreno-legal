import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell, ShellAction } from "@/components/AppShell";
import {
  Card,
  CardLink,
  Chip,
  EmptyState,
  Icon,
  Notice,
  Section,
} from "@/components/ui";
import { loadAccessibleMembers, loadDocuments, loadImpactReviews } from "./queries";

export const dynamic = "force-dynamic";

const ESTADOS: Record<string, { texto: string; tono: "neutro" | "atencion" | "primario" | "peligro" }> = {
  UPLOADED: { texto: "subido", tono: "neutro" },
  PROCESSING: { texto: "procesando", tono: "neutro" },
  EXTRACTED: { texto: "por revisar", tono: "atencion" },
  NEEDS_REVIEW: { texto: "por revisar", tono: "atencion" },
  CONFIRMED: { texto: "confirmado", tono: "primario" },
  FAILED: { texto: "no se pudo leer", tono: "peligro" },
  ARCHIVED: { texto: "archivado", tono: "neutro" },
};

const RELACION: Record<string, string> = {
  SELF: "tus datos",
  GRANTED: "acceso concedido",
  DEPENDENT: "a tu cargo",
};

/**
 * /health (§51): dashboard según permisos. Sin alarmismo: estados y tareas,
 * nunca veredictos de salud. Quien no tiene acceso a nadie ve SU espacio
 * vacío — jamás una pista de los datos ajenos.
 */
export default async function HealthPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/health");

  const miembros = await loadAccessibleMembers(supabase);
  const [documentos, impactos] = await Promise.all([
    loadDocuments(supabase),
    loadImpactReviews(supabase),
  ]);

  const porRevisar = documentos.filter((d) =>
    ["NEEDS_REVIEW", "EXTRACTED"].includes(d.processing_status),
  );

  return (
    <AppShell
      active="health"
      title="Salud"
      subtitle="Exámenes, datos confirmados y restricciones verificadas. Privado por persona."
      action={
        <ShellAction href="/health/exams/upload">
          <Icon name="upload_file" className="text-[18px]" />
          Subir examen
        </ShellAction>
      }
    >
      {impactos.length > 0 && (
        <Section className="mt-md">
          <Notice icon="pending_actions">
            <p className="font-semibold">
              {impactos.length}{" "}
              {impactos.length === 1
                ? "revisión de impacto pendiente"
                : "revisiones de impacto pendientes"}
            </p>
            <p className="mt-0.5">
              Cambió información clínica: nada se aplica solo — revisa qué comidas y compras
              tocaría.
            </p>
            <ul className="mt-sm space-y-1">
              {impactos.map((i) => (
                <li key={i.id}>
                  <a href={`/health/member/${i.member_id}`} className="font-semibold underline">
                    {i.trigger_kind === "LAB_RESULTS_CONFIRMED"
                      ? "Nuevo examen confirmado"
                      : "Cambio de restricción"}{" "}
                    · revisar impacto
                  </a>
                </li>
              ))}
            </ul>
          </Notice>
        </Section>
      )}

      {porRevisar.length > 0 && (
        <Section
          title="Datos por revisar"
          hint="Lo extraído por IA no afecta ninguna decisión hasta que una persona lo confirme."
          className={impactos.length > 0 ? "" : "mt-md"}
        >
          <ul className="space-y-sm">
            {porRevisar.map((d) => (
              <li key={d.id}>
                <CardLink href={`/health/exams/${d.id}/review`} className="flex items-center gap-md p-md">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-secondary-fixed text-on-secondary-fixed-variant">
                    <Icon name="fact_check" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-body-md text-body-md font-semibold">
                      {d.source_lab_name ?? "Examen"}
                    </span>
                    <span className="block font-body-sm text-body-sm text-on-surface-variant">
                      {d.document_date ?? "sin fecha"}
                    </span>
                  </span>
                  <Chip tono="atencion">revisar</Chip>
                </CardLink>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Personas" className={impactos.length || porRevisar.length ? "" : "mt-md"}>
        {miembros.length === 0 ? (
          <EmptyState icon="lock">
            No tienes acceso al módulo de salud de nadie todavía. Cada persona ve lo suyo; el
            acceso a datos de otra persona requiere un permiso explícito de ella.
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-1 gap-sm sm:grid-cols-2">
            {miembros.map((m) => (
              <li key={m.id}>
                <CardLink href={`/health/member/${m.id}`} className="flex items-center gap-md p-md">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-fixed font-headline-sm text-headline-sm text-on-primary-fixed">
                    {m.displayName.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-body-md text-body-md font-semibold">
                      {m.displayName}
                    </span>
                    <span className="block font-body-sm text-body-sm text-on-surface-variant">
                      {RELACION[m.relation]}
                    </span>
                  </span>
                  <Icon name="chevron_right" className="text-outline" />
                </CardLink>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Exámenes recientes">
        {documentos.length === 0 ? (
          <EmptyState icon="description">Sin exámenes visibles para ti.</EmptyState>
        ) : (
          <ul className="space-y-sm">
            {documentos.slice(0, 8).map((d) => {
              const e = ESTADOS[d.processing_status] ?? { texto: d.processing_status, tono: "neutro" as const };
              return (
                <li key={d.id}>
                  <CardLink
                    href={`/health/exams/${d.id}/review`}
                    className="flex items-center justify-between gap-md p-md"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-body-md text-body-md">
                        {d.source_lab_name ?? "Examen"}
                      </span>
                      <span className="block font-body-sm text-body-sm text-on-surface-variant">
                        {d.document_date ?? "sin fecha"}
                      </span>
                    </span>
                    <Chip tono={e.tono}>{e.texto}</Chip>
                  </CardLink>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Card className="mt-lg flex items-start gap-sm p-md">
        <Icon name="shield_lock" className="mt-0.5 shrink-0 text-primary" />
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Los roles del hogar (administrar, planificar, cocinar, comprar) <strong>no</strong> dan
          acceso a datos médicos. Cada permiso se concede y se revoca uno por uno.
        </p>
      </Card>
    </AppShell>
  );
}
