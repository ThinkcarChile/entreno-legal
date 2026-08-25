import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import {
  loadAccessibleMembers,
  loadDocuments,
  loadImpactReviews,
} from "./queries";

export const dynamic = "force-dynamic";

const ESTADOS: Record<string, string> = {
  UPLOADED: "subido",
  PROCESSING: "procesando",
  EXTRACTED: "extraído",
  NEEDS_REVIEW: "por revisar",
  CONFIRMED: "confirmado",
  FAILED: "falló",
  ARCHIVED: "archivado",
};

/**
 * /health (§51): dashboard según permisos. Sin alarmismo: estados y tareas,
 * nunca veredictos de salud. Quien no tiene acceso a nadie ve SU espacio vacío
 * — jamás una pista de los datos ajenos.
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
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="health" />
      <header className="mb-4 flex items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Salud</h1>
          <p className="text-xs text-[var(--ink)]/60">
            Exámenes, datos confirmados y restricciones verificadas. Privado por persona.
          </p>
        </div>
        <Link
          href="/health/exams/upload"
          className="shrink-0 rounded-full bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white"
        >
          Subir examen
        </Link>
      </header>

      {impactos.length > 0 && (
        <section className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">
            {impactos.length}{" "}
            {impactos.length === 1 ? "revisión de impacto pendiente" : "revisiones de impacto pendientes"}
          </h2>
          <p className="mt-1 text-xs text-amber-900/80">
            Cambió información clínica: nada se aplica solo — revisa qué comidas y compras tocaría.
          </p>
          <ul className="mt-2 space-y-1 text-xs text-amber-900">
            {impactos.map((i) => (
              <li key={i.id}>
                <Link href={`/health/member/${i.member_id}`} className="underline">
                  {i.trigger_kind === "LAB_RESULTS_CONFIRMED"
                    ? "Nuevo examen confirmado"
                    : "Cambio de restricción"}{" "}
                  · revisar impacto
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {porRevisar.length > 0 && (
        <section className="mb-4 rounded-2xl border border-[var(--accent)]/40 bg-white p-4">
          <h2 className="text-sm font-semibold">Datos por revisar</h2>
          <p className="mt-1 text-xs text-[var(--ink)]/60">
            Lo extraído por IA no afecta ninguna decisión hasta que una persona lo confirme.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {porRevisar.map((d) => (
              <li key={d.id}>
                <Link href={`/health/exams/${d.id}/review`} className="text-[var(--accent)] underline">
                  {d.source_lab_name ?? "Examen"} · {d.document_date ?? "sin fecha"} ·{" "}
                  {ESTADOS[d.processing_status] ?? d.processing_status}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-4">
        <h2 className="mb-2 text-sm font-semibold">Personas</h2>
        {miembros.length === 0 ? (
          <p className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4 text-sm text-[var(--ink)]/60">
            No tienes acceso al módulo de salud de nadie todavía. Cada persona ve lo suyo; el
            acceso a datos de otra persona requiere un permiso explícito de ella.
          </p>
        ) : (
          <ul className="space-y-2">
            {miembros.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/health/member/${m.id}`}
                  className="flex items-center justify-between rounded-2xl border border-[var(--ink)]/10 bg-white p-4"
                >
                  <span className="font-medium">{m.displayName}</span>
                  <span className="rounded-full bg-[var(--paper)] px-2.5 py-1 text-[10px] text-[var(--ink)]/60">
                    {m.relation === "SELF"
                      ? "tus datos"
                      : m.relation === "GRANTED"
                        ? "acceso concedido"
                        : "a tu cargo"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Exámenes recientes</h2>
        {documentos.length === 0 ? (
          <p className="rounded-2xl border border-[var(--ink)]/10 bg-white p-4 text-sm text-[var(--ink)]/60">
            Sin exámenes visibles para ti.
          </p>
        ) : (
          <ul className="space-y-2">
            {documentos.slice(0, 8).map((d) => (
              <li key={d.id} className="rounded-2xl border border-[var(--ink)]/10 bg-white p-3 text-sm">
                <Link href={`/health/exams/${d.id}/review`} className="flex items-center justify-between">
                  <span>
                    {d.source_lab_name ?? "Examen"} · {d.document_date ?? "sin fecha"}
                  </span>
                  <span className="rounded-full bg-[var(--paper)] px-2.5 py-1 text-[10px]">
                    {ESTADOS[d.processing_status] ?? d.processing_status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
