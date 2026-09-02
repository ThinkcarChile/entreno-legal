import { redirect } from "next/navigation";
import Link from "next/link";
import { createSupabaseServer } from "@/lib/supabase/server";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { AppShell } from "@/components/AppShell";
import { Card, CardLink, Chip, EmptyState, LinkButton, Notice } from "@/components/ui";
import { loadReceipts } from "./queries";

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

/** /finanzas/boletas — las boletas del hogar y en qué va cada una. */
export default async function BoletasPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/finanzas/boletas");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (householdId === null) redirect("/onboarding");

  // Si esta consulta falla LANZA y se ve el error: una lista de boletas vacía
  // porque la consulta se cayó se lee igual que "no has comprado nada".
  const boletas = await loadReceipts(supabase, householdId);

  return (
    <AppShell
      active="shopping"
      title="Boletas"
      subtitle="Lo que se compró, con el papel que lo respalda."
      action={<LinkButton href="/finanzas/boletas/upload">Subir boleta</LinkButton>}
    >
      <div className="mt-md space-y-md">
        <Notice icon="savings" tono="atencion">
          Una boleta confirmada deja <strong>valor guardado</strong> en la despensa, no un gasto
          consumido. El gasto aparece cuando eso se come, se echa a perder o se pierde.
        </Notice>

        {boletas.length === 0 ? (
          <EmptyState icon="receipt_long">
            Todavía no hay boletas. Sube la del último súper y lo comprado entra con su precio.
          </EmptyState>
        ) : (
          <ul className="space-y-sm">
            {boletas.map((b) => {
              const e = ESTADO[b.processing_status] ?? {
                texto: b.processing_status,
                tono: "neutro" as const,
              };
              return (
                <li key={b.id}>
                  <CardLink href={`/finanzas/boletas/${b.id}/review`} className="block p-md">
                    <div className="flex flex-wrap items-start justify-between gap-sm">
                      <div className="min-w-0">
                        <p className="font-body-md text-body-md font-semibold text-on-surface">
                          {b.merchant_name ?? "Comercio sin nombre"}
                        </p>
                        <p className="font-body-sm text-body-sm text-on-surface-variant">
                          {b.receipt_date ?? "sin fecha impresa"}
                          {b.receipt_number === null ? "" : ` · folio ${b.receipt_number}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Chip tono={e.tono}>{e.texto}</Chip>
                        {b.duplicate_of !== null && b.duplicate_ack_at === null && (
                          <Chip tono="peligro" icon="content_copy">
                            posible duplicado
                          </Chip>
                        )}
                      </div>
                    </div>
                  </CardLink>
                </li>
              );
            })}
          </ul>
        )}

        <Card className="p-md">
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            ¿La mercadería ya entró con la lista de compras y la boleta apareció después?{" "}
            <Link href="/finanzas/boletas/upload" className="font-semibold text-primary underline">
              Súbela marcándola como «ya llegó»
            </Link>{" "}
            y solo se le pondrá precio a lo que ya está guardado, sin volver a meterlo.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
