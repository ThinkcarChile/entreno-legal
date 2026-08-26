import { uuidParam } from "@/lib/route-params";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Card, Chip, Icon, LinkButton, Notice, Section } from "@/components/ui";
import { effectiveDate, formatDate } from "@/domain/nutrition/calendar";
import { formatQuantity } from "@/domain/shopping/engine";
import { analyzeStock } from "@/domain/stock/engine";
import { expiryInfo } from "@/domain/inventory/fefo";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { loadStockInput } from "@/app/stock/queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { coverageText } from "../../StockOverview";
import { ItemDetailActions } from "./ItemDetailActions";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ ingredientId: string }>;
  searchParams: Promise<{ unit?: string }>;
}

const CONFIDENCE_LABELS = { LOW: "baja", MEDIUM: "media", HIGH: "alta" } as const;

/**
 * Detalle de un alimento (§31): stock, lotes, reservas, consumo, cobertura,
 * objetivo y la recomendación con su "¿Por qué?" completo (§29).
 */
export default async function StockItemPage({ params, searchParams }: Props) {
  const { ingredientId: ingredientIdCrudo } = await params;
  const ingredientId = uuidParam(ingredientIdCrudo);
  const { unit } = await searchParams;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/pantry");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) redirect("/pantry");

  const { data: hogar, error: hogarError } = await supabase
    .from("households")
    .select("timezone")
    .eq("id", householdId)
    .maybeSingle();
  if (hogarError) throw new DataAccessError("zona horaria del hogar", hogarError);
  const hoy = effectiveDate(new Date(), hogar?.timezone ?? "America/Santiago");

  const input = await loadStockInput(supabase, householdId, hoy, hogar?.timezone ?? "America/Santiago");
  const items = analyzeStock(input);
  const item =
    items.find((i) => i.ingredientId === ingredientId && (!unit || i.unit === unit)) ?? null;
  if (!item) notFound();

  const shortfallsPropios = input.shortfalls.filter((s) => s.ingredientId === ingredientId);

  const tarjetas = [
    { k: "Cobertura", icon: "event_available", v: coverageText(item) },
    {
      k: "Consumo 7 días",
      icon: "trending_down",
      v: item.rate.last7 !== null ? formatQuantity(item.rate.last7, item.unit) : "—",
    },
    {
      k: "Consumo 30 días",
      icon: "calendar_month",
      v: item.rate.last30 !== null ? formatQuantity(item.rate.last30, item.unit) : "—",
    },
    {
      k: "Confianza",
      icon: "verified",
      v: item.confidence ? CONFIDENCE_LABELS[item.confidence] : "sin datos",
    },
  ];

  return (
    <AppShell
      active="pantry"
      title={`${item.hasApproximate ? "~" : ""}${item.label}`}
      subtitle={`En casa ${formatQuantity(item.onHand, item.unit)} · reservado ${formatQuantity(
        item.reserved,
        item.unit,
      )} · ${
        item.available >= 0
          ? `libre ${formatQuantity(item.available, item.unit)}`
          : `faltan ${formatQuantity(-item.available, item.unit)} para el plan`
      }`}
      action={
        <LinkButton href="/pantry" variant="outline">
          <Icon name="arrow_back" className="text-[18px]" />
          Despensa
        </LinkButton>
      }
    >
      <Section className="mt-md">
        <ul className="grid grid-cols-2 gap-sm sm:grid-cols-4">
          {tarjetas.map((c) => (
            <li key={c.k}>
              <Card className="h-full p-md">
                <p className="font-label-md text-label-md uppercase text-on-surface-variant">
                  {c.k}
                </p>
                <p className="mt-1 flex items-center gap-1 font-headline-sm text-headline-sm text-on-surface">
                  <Icon name={c.icon} className="shrink-0 text-[20px] text-primary" />
                  <span className="min-w-0 truncate">{c.v}</span>
                </p>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section>
        <Card className="p-md">
          <h2 className="flex items-start gap-sm font-headline-sm text-headline-sm text-on-surface">
            <Icon name="shopping_cart" className="mt-0.5 shrink-0 text-primary" />
            <span className="min-w-0">
              {item.reorder.recommendedQuantity !== null
                ? `Recomendación: comprar ${formatQuantity(item.reorder.recommendedQuantity, item.unit)}`
                : item.reorder.status === "UNRESOLVED"
                  ? "Recomendación sin resolver"
                  : "Sin compra recomendada por ahora"}
            </span>
          </h2>
          <details className="mt-sm">
            <summary className="cursor-pointer font-body-sm text-body-sm font-semibold text-primary">
              ¿Por qué?
            </summary>
            <ul className="mt-sm list-inside list-disc space-y-1 font-body-sm text-body-sm text-on-surface-variant">
              {item.reorder.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
              {item.confidenceReasons.map((r, i) => (
                <li key={`c${i}`}>{r}</li>
              ))}
              {item.rate.historyDays > 0 && (
                <li>Hay {item.rate.historyDays} días de historia válida.</li>
              )}
            </ul>
            <p className="mt-sm font-label-md text-label-md text-outline">
              {item.reorder.forecastVersion} · {item.reorder.engineVersion} · horizonte{" "}
              {item.reorder.horizonDays} días
            </p>
          </details>
        </Card>
      </Section>

      {item.unresolvedDemand.length > 0 && (
        <Section>
          <Notice icon="help">
            <p className="font-semibold">Demanda sin resolver</p>
            {item.unresolvedDemand.map((d, i) => (
              <p key={i} className="mt-0.5">
                {formatQuantity(d.quantity, d.unit)} ({d.weightBasis.toLowerCase()}): {d.reason}
              </p>
            ))}
          </Notice>
        </Section>
      )}

      <Section title="Lotes">
        <Card className="p-md">
          {item.lots.length === 0 ? (
            <p className="font-body-sm text-body-sm text-on-surface-variant">Sin lotes usables.</p>
          ) : (
            <ul className="space-y-sm">
              {item.lots.map((l) => {
                const info = expiryInfo(l, hoy);
                return (
                  <li
                    key={l.id}
                    className="flex flex-wrap items-center justify-between gap-x-md gap-y-1 rounded-2xl bg-surface-container-low px-md py-sm"
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="min-w-0 truncate font-body-md text-body-md text-on-surface">
                        {l.isApproximate && "~"}
                        {l.label}
                      </span>
                      {item.useFirstLotId === l.id && (
                        <Chip tono="primario" icon="bolt">
                          usa primero
                        </Chip>
                      )}
                    </span>
                    <span className="shrink-0 text-right font-body-sm text-body-sm text-on-surface">
                      {formatQuantity(l.quantity, l.unit)}
                      {info.state !== "NO_DATE" && (
                        <span className="text-on-surface-variant">
                          {" "}
                          · vence {formatDate((l.useBy ?? l.expiryDate)!)}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </Section>

      {(item.waste30 > 0 || shortfallsPropios.length > 0 || item.overbuySignal) && (
        <Section title="Señales">
          <Card className="space-y-sm p-md font-body-sm text-body-sm text-on-surface-variant">
            {item.waste30 > 0 && (
              <p>
                Merma últimos 30 días: {formatQuantity(item.waste30, item.unit)}
                {item.wasteCost30 !== null && <> (~${item.wasteCost30.toLocaleString("es-CL")})</>}
              </p>
            )}
            {item.overbuySignal && (
              <Notice icon="trending_up">
                Históricamente compras por encima del consumo observado. Tu objetivo no se cambió:
                decide tú si quieres ajustarlo.
              </Notice>
            )}
            {shortfallsPropios.length > 0 && (
              <p>
                Consumo no trazado reciente:{" "}
                {formatQuantity(
                  shortfallsPropios.reduce((a, s) => a + s.quantity, 0),
                  item.unit,
                )}{" "}
                en {shortfallsPropios.length}{" "}
                {shortfallsPropios.length === 1 ? "comida" : "comidas"}.
              </p>
            )}
          </Card>
        </Section>
      )}

      <ItemDetailActions
        ingredientId={item.ingredientId}
        label={item.label}
        unit={item.unit}
        target={item.target}
      />
    </AppShell>
  );
}
