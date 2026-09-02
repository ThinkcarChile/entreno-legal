import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Card, Chip, DataRow, EmptyState, Notice, Section } from "@/components/ui";
import { uuidParam } from "@/lib/route-params";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { loadCandidates, loadEtiquetas, loadLotesSinValor, loadReceipt } from "../../queries";
import { ReviewTable, type FilaBoleta } from "./ReviewTable";
import { AttachTable, type LoteSinValor } from "./AttachTable";

export const dynamic = "force-dynamic";

const ESTADO: Record<
  string,
  { texto: string; tono: "neutro" | "atencion" | "primario" | "peligro" }
> = {
  UPLOADED: { texto: "subida", tono: "neutro" },
  PROCESSING: { texto: "leyendo", tono: "neutro" },
  EXTRACTED: { texto: "leída", tono: "atencion" },
  NEEDS_REVIEW: { texto: "por revisar", tono: "atencion" },
  CONFIRMED: { texto: "confirmada", tono: "primario" },
  FAILED: { texto: "no se pudo leer", tono: "peligro" },
  ARCHIVED: { texto: "archivada", tono: "neutro" },
};

/**
 * /finanzas/boletas/[id]/review — la revisión humana.
 *
 * Nada de lo que se ve acá tocó la despensa, los precios ni el gasto, y eso se
 * dice en pantalla. Lo que la boleta propone son CANDIDATOS; la puerta al
 * inventario la abre una persona, línea por línea.
 */
export default async function RevisarBoletaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lectura?: string; consentimiento?: string; ya?: string }>;
}) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/finanzas/boletas");

  const { id: idCrudo } = await params;
  const id = uuidParam(idCrudo);
  const { lectura, consentimiento, ya } = await searchParams;

  const boleta = await loadReceipt(supabase, id);
  if (boleta === null) redirect("/finanzas/boletas");

  const adjuntar = boleta.intent === "ATTACH_TO_EXISTING";

  const candidatos =
    boleta.extraction_pass === 0 ? [] : await loadCandidates(supabase, id, boleta.extraction_pass);

  const ingredientes = candidatos
    .map((c) => c.matched_ingredient_id)
    .filter((x): x is string => x !== null);
  const productos = candidatos
    .map((c) => c.matched_product_id)
    .filter((x): x is string => x !== null);
  const etiquetas = await loadEtiquetas(supabase, ingredientes, productos);

  const filas: FilaBoleta[] = candidatos.map((c) => ({
    id: c.id,
    lineOrdinal: c.line_ordinal,
    rawLineText: c.raw_line_text,
    snippet: c.original_snippet,
    quantity: c.quantity,
    unit: c.unit,
    unitPriceMinor: c.unit_price_minor === null ? null : c.unit_price_minor.toString(),
    unitPriceBasis: c.unit_price_basis,
    lineTotalMinor: c.line_total_minor === null ? null : c.line_total_minor.toString(),
    discountMinor: c.discount_minor === null ? null : c.discount_minor.toString(),
    barcode: c.barcode,
    barcodeCheckOk: c.barcode_check_ok,
    matchMethod: c.match_method,
    matchScore: c.match_score,
    doubtReasons: c.doubt_reasons,
    status: c.status,
    etiqueta:
      c.matched_product_id !== null
        ? (etiquetas[c.matched_product_id] ?? null)
        : c.matched_ingredient_id !== null
          ? (etiquetas[c.matched_ingredient_id] ?? null)
          : null,
  }));

  // Los lotes que todavía no saben lo que costaron sólo hacen falta en la puerta
  // de adjuntar. Si esta consulta falla LANZA: una lista vacía se leería como
  // "no hay nada guardado esperando precio", que es una respuesta distinta.
  let lotesSinValor: LoteSinValor[] = [];
  if (adjuntar) {
    const { householdId } = await loadHouseholdMembers(supabase);
    // Sin hogar no hay despensa que consultar, y eso NO es «no hay nada
    // esperando precio»: es que no se pudo preguntar. Se dice, no se dibuja
    // una lista vacia que invitaria a marcar todas las lineas como descartadas.
    if (householdId === null) {
      throw new Error(
        "No se pudo saber a que hogar pertenece esta boleta, asi que no se pueden listar los lotes que esperan su precio.",
      );
    }
    lotesSinValor = (await loadLotesSinValor(supabase, householdId)).map((l) => ({
      id: l.id,
      label: l.label,
      quantity: l.quantity,
      unit: l.unit,
    }));
  }

  const e = ESTADO[boleta.processing_status] ?? {
    texto: boleta.processing_status,
    tono: "neutro" as const,
  };
  const cerrada =
    boleta.processing_status === "CONFIRMED" || boleta.processing_status === "ARCHIVED";

  return (
    <AppShell
      active="shopping"
      title="Revisión de la boleta"
      subtitle={`${boleta.merchant_name ?? "Comercio sin nombre"} · ${
        boleta.receipt_date ?? "sin fecha impresa"
      }`}
      action={<Chip tono={e.tono}>{e.texto}</Chip>}
    >
      <div className="mt-md space-y-md">
        <Notice icon="rule" tono="info">
          Lo leído es una <strong>propuesta</strong>: no toca la despensa, ni los precios, ni el
          gasto, hasta que lo confirmes línea por línea.
          {boleta.extraction_version !== null && (
            <span className="mt-0.5 block opacity-80">Lector: {boleta.extraction_version}</span>
          )}
        </Notice>

        {ya === "1" && (
          <Notice icon="content_copy">
            Esta misma boleta ya estaba subida: te dejamos en la que ya existe en vez de crear otra.
          </Notice>
        )}
        {lectura === "fallida" && (
          <Notice icon="error">
            La lectura automática no pudo leer este archivo. No se inventó ninguna línea: puedes
            registrar la compra a mano o volver a subirla en un formato legible.
          </Notice>
        )}
        {consentimiento === "denegado" && (
          <Notice icon="lock">
            No se pudo registrar el consentimiento para la lectura automática: autorizar el envío a
            un modelo externo exige más permiso que subir la foto, porque manda datos de todos los
            que viven en la casa. La boleta quedó guardada y se puede revisar a mano.
          </Notice>
        )}
        {boleta.failure_reason !== null && (
          <Notice icon="info">{boleta.failure_reason}</Notice>
        )}

        <Section title="Lo que dice el papel">
          <Card className="px-md py-sm">
            <DataRow label="Comercio">{boleta.merchant_name ?? "no se leyó"}</DataRow>
            <DataRow label="Fecha impresa">{boleta.receipt_date ?? "no se leyó"}</DataRow>
            <DataRow label="Folio">{boleta.receipt_number ?? "no se leyó"}</DataRow>
            <DataRow label="Total leído">
              {boleta.declared_total_minor === null
                ? "no se leyó"
                : boleta.declared_total_minor.toString()}
            </DataRow>
            <DataRow label="Destino">
              {adjuntar
                ? "adjuntar: la mercadería ya está guardada, acá solo llega el precio"
                : "compra nueva: al confirmar entra a la despensa"}
            </DataRow>
          </Card>
        </Section>

        {cerrada ? (
          <EmptyState icon="task_alt">
            {boleta.purchase_id === null
              ? "Esta boleta está cerrada y no generó ninguna compra."
              : "Esta boleta ya generó su compra. Sus líneas son historia y no se vuelven a confirmar."}
          </EmptyState>
        ) : adjuntar ? (
          <AttachTable
            receiptId={id}
            currency={boleta.currency}
            filas={filas}
            lotes={lotesSinValor}
            totalExtraidoMinor={
              boleta.declared_total_minor === null ? null : boleta.declared_total_minor.toString()
            }
            totalSource={boleta.total_source}
            duplicadoDe={boleta.duplicate_of}
            duplicadoDeclarado={boleta.duplicate_ack_at !== null}
          />
        ) : (
          <ReviewTable
            receiptId={id}
            currency={boleta.currency}
            filas={filas}
            totalExtraidoMinor={
              boleta.declared_total_minor === null ? null : boleta.declared_total_minor.toString()
            }
            totalSource={boleta.total_source}
            fechaImpresa={boleta.receipt_date}
            duplicadoDe={boleta.duplicate_of}
            duplicadoDeclarado={boleta.duplicate_ack_at !== null}
          />
        )}
      </div>
    </AppShell>
  );
}
