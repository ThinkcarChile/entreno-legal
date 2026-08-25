import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import { uuidParam } from "@/lib/route-params";
import { loadBiomarkers, loadCandidates, loadDocument, loadObservations } from "../../../queries";
import { ReviewTable } from "./ReviewTable";

export const dynamic = "force-dynamic";

/**
 * /health/exams/[id]/review (§10): la revisión humana. Nada de lo que se ve
 * acá afecta decisiones hasta CONFIRMAR — y eso se dice en pantalla.
 */
export default async function ReviewExamPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ extraccion?: string }>;
}) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/health");

  const { id: idCrudo } = await params;
  const id = uuidParam(idCrudo);
  const { extraccion } = await searchParams;

  const doc = await loadDocument(supabase, id);
  if (!doc) redirect("/health");

  const [candidatos, biomarcadores, observaciones] = await Promise.all([
    loadCandidates(supabase, id),
    loadBiomarkers(supabase),
    loadObservations(supabase, doc.member_id),
  ]);
  const delDocumento = observaciones.filter((o) => o.document_id === id);

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="health" />
      <h1 className="mb-1 text-xl font-semibold">Revisión del examen</h1>
      <p className="mb-1 text-xs text-[var(--ink)]/60">
        {doc.source_lab_name ?? "Examen"} · {doc.document_date ?? "sin fecha"} · estado:{" "}
        {doc.processing_status}
        {doc.extraction_version && ` · extractor ${doc.extraction_version}`}
      </p>
      <p className="mb-4 rounded-xl bg-[var(--paper)] px-3 py-2 text-xs text-[var(--ink)]/70">
        Lo extraído es una PROPUESTA: no afecta reglas, comidas ni compras hasta que lo
        confirmes fila por fila.
      </p>

      {extraccion === "fallida" && (
        <p className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
          La extracción automática no pudo leer este documento. Puedes registrar los valores a
          mano cuando la edición manual esté disponible, o subir el examen en formato texto.
        </p>
      )}

      <ReviewTable
        documentId={id}
        candidatos={candidatos.map((c) => ({
          id: c.id,
          biomarkerId: c.biomarker_id,
          rawLabel: c.raw_label,
          value: c.value,
          unit: c.unit,
          referenceLow: c.reference_low,
          referenceHigh: c.reference_high,
          referenceText: c.reference_text,
          collectedDate: c.collected_date,
          confidence: c.extraction_confidence,
          snippet: c.original_snippet,
          status: c.status,
        }))}
        biomarcadores={biomarcadores.map((b) => ({ id: b.id, nombre: b.display_name }))}
      />

      {delDocumento.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">Observaciones confirmadas de este examen</h2>
          <ul className="space-y-1 text-sm">
            {delDocumento.map((o) => (
              <li key={o.id} className="rounded-xl border border-[var(--ink)]/10 bg-white px-3 py-2">
                {o.value} {o.unit ?? "(unidad desconocida)"} ·{" "}
                {o.reference_text ??
                  (o.reference_low !== null && o.reference_high !== null
                    ? `rango del laboratorio ${o.reference_low}–${o.reference_high}`
                    : "sin rango impreso")}{" "}
                · {o.verification_status}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
