import { uuidParam } from "@/lib/route-params";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
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

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="pantry" />
      <Link href="/pantry" className="text-xs text-[var(--accent)] underline">
        ← Despensa
      </Link>

      <header className="mb-4 mt-2">
        <h1 className="text-2xl font-semibold">
          {item.hasApproximate && "~"}
          {item.label}
        </h1>
        <p className="mt-1 text-sm text-[var(--ink)]/60">
          En casa {formatQuantity(item.onHand, item.unit)} · reservado{" "}
          {formatQuantity(item.reserved, item.unit)} ·{" "}
          {item.available >= 0
            ? `libre ${formatQuantity(item.available, item.unit)}`
            : `faltan ${formatQuantity(-item.available, item.unit)} para el plan`}
        </p>
      </header>

      <section className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { k: "Cobertura", v: coverageText(item) },
          {
            k: "Consumo 7 días",
            v: item.rate.last7 !== null ? formatQuantity(item.rate.last7, item.unit) : "—",
          },
          {
            k: "Consumo 30 días",
            v: item.rate.last30 !== null ? formatQuantity(item.rate.last30, item.unit) : "—",
          },
          {
            k: "Confianza",
            v: item.confidence ? CONFIDENCE_LABELS[item.confidence] : "sin datos",
          },
        ].map((c) => (
          <div key={c.k} className="rounded-2xl border border-[var(--ink)]/10 bg-white p-3">
            <p className="text-[10px] uppercase tracking-wide text-[var(--ink)]/50">{c.k}</p>
            <p className="mt-0.5 text-sm font-semibold">{c.v}</p>
          </div>
        ))}
      </section>

      <section className="mb-4 rounded-2xl border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-4">
        <h2 className="text-sm font-semibold">
          {item.reorder.recommendedQuantity !== null
            ? `Recomendación: comprar ${formatQuantity(item.reorder.recommendedQuantity, item.unit)}`
            : item.reorder.status === "UNRESOLVED"
              ? "Recomendación sin resolver"
              : "Sin compra recomendada por ahora"}
        </h2>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-[var(--accent)]">
            ¿Por qué?
          </summary>
          <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-[var(--ink)]/70">
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
          <p className="mt-2 text-[10px] text-[var(--ink)]/40">
            {item.reorder.forecastVersion} · {item.reorder.engineVersion} · horizonte{" "}
            {item.reorder.horizonDays} días
          </p>
        </details>
      </section>

      {item.unresolvedDemand.length > 0 && (
        <section className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <h2 className="mb-1 font-semibold">Demanda sin resolver</h2>
          {item.unresolvedDemand.map((d, i) => (
            <p key={i}>
              {formatQuantity(d.quantity, d.unit)} ({d.weightBasis.toLowerCase()}): {d.reason}
            </p>
          ))}
        </section>
      )}

      <section className="mb-4 rounded-2xl border border-[var(--ink)]/10 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold">Lotes</h2>
        {item.lots.length === 0 ? (
          <p className="text-xs text-[var(--ink)]/50">Sin lotes usables.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {item.lots.map((l) => {
              const info = expiryInfo(l, hoy);
              return (
                <li key={l.id} className="flex items-center justify-between gap-2 rounded-xl border border-[var(--ink)]/10 px-3 py-2">
                  <span className="min-w-0 truncate">
                    {l.isApproximate && "~"}
                    {l.label}
                    {item.useFirstLotId === l.id && (
                      <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] text-emerald-900">
                        usa primero
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-right">
                    {formatQuantity(l.quantity, l.unit)}
                    {info.state !== "NO_DATE" && (
                      <span className="ml-1 text-[var(--ink)]/40">
                        · vence {formatDate((l.useBy ?? l.expiryDate)!)}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {(item.waste30 > 0 || shortfallsPropios.length > 0 || item.overbuySignal) && (
        <section className="mb-4 rounded-2xl border border-[var(--ink)]/10 bg-white p-4 text-xs">
          <h2 className="mb-2 text-sm font-semibold">Señales</h2>
          {item.waste30 > 0 && (
            <p>
              Merma últimos 30 días: {formatQuantity(item.waste30, item.unit)}
              {item.wasteCost30 !== null && <> (~${item.wasteCost30.toLocaleString("es-CL")})</>}
            </p>
          )}
          {item.overbuySignal && (
            <p className="mt-1 text-amber-800">
              Históricamente compras por encima del consumo observado. Tu objetivo no se cambió:
              decide tú si quieres ajustarlo.
            </p>
          )}
          {shortfallsPropios.length > 0 && (
            <p className="mt-1">
              Consumo no trazado reciente:{" "}
              {formatQuantity(
                shortfallsPropios.reduce((a, s) => a + s.quantity, 0),
                item.unit,
              )}{" "}
              en {shortfallsPropios.length} {shortfallsPropios.length === 1 ? "comida" : "comidas"}.
            </p>
          )}
        </section>
      )}

      <ItemDetailActions
        ingredientId={item.ingredientId}
        label={item.label}
        unit={item.unit}
        target={item.target}
      />
    </main>
  );
}
