import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Card, Chip, DataRow, Notice, Section } from "@/components/ui";
import { uuidParam } from "@/lib/route-params";
import { loadBiomarkers, loadCandidates, loadDocument, loadObservations } from "../../../queries";
import { ReviewTable } from "./ReviewTable";

export const dynamic = "force-dynamic";

const ESTADO: Record<string, { texto: string; tono: "neutro" | "atencion" | "primario" | "peligro" }> = {
  UPLOADED: { texto: "subido", tono: "neutro" },
  PROCESSING: { texto: "procesando", tono: "neutro" },
  EXTRACTED: { texto: "extraído", tono: "atencion" },
  NEEDS_REVIEW: { texto: "por revisar", tono: "atencion" },
  CONFIRMED: { texto: "confirmado", tono: "primario" },
  FAILED: { texto: "no se pudo leer", tono: "peligro" },
  ARCHIVED: { texto: "archivado", tono: "neutro" },
};

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
  const e = ESTADO[doc.processing_status] ?? { texto: doc.processing_status, tono: "neutro" as const };

  return (
    <AppShell
      active="health"
      title="Revisión del examen"
      subtitle={`${doc.source_lab_name ?? "Examen"} · ${doc.document_date ?? "sin fecha"}`}
      action={<Chip tono={e.tono}>{e.texto}</Chip>}
    >
      <div className="mt-md space-y-md">
        <Notice icon="rule" tono="info">
          Lo extraído es una <strong>propuesta</strong>: no afecta reglas, comidas ni compras
          hasta que lo confirmes fila por fila.
          {doc.extraction_version && (
            <span className="mt-0.5 block opacity-80">Extractor: {doc.extraction_version}</span>
          )}
        </Notice>

        {extraccion === "fallida" && (
          <Notice icon="error">
            La extracción automática no pudo leer este documento. Puedes registrar los valores a
            mano, o subir el examen en formato texto.
          </Notice>
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
          <Section title="Confirmadas de este examen">
            <Card className="px-md py-sm">
              {delDocumento.map((o) => (
                <DataRow
                  key={o.id}
                  label={
                    o.reference_text ??
                    (o.reference_low !== null && o.reference_high !== null
                      ? `rango del laboratorio ${o.reference_low}–${o.reference_high}`
                      : "sin rango impreso")
                  }
                >
                  <strong>{o.value}</strong>{" "}
                  {o.unit ?? <span className="text-on-surface-variant">(unidad desconocida)</span>}
                </DataRow>
              ))}
            </Card>
          </Section>
        )}
      </div>
    </AppShell>
  );
}
