import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import { addDays, effectiveDate, weekLabel, weekStart } from "@/domain/nutrition/calendar";
import { aggregateDemand, demandSignature } from "@/domain/shopping/engine";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { loadShoppingContext, loadShoppingList } from "./queries";
import { ShoppingBoard } from "./ShoppingBoard";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ semana?: string }>;
}

/**
 * La compra de la semana (§32). La lista oficial sale SOLO de las porciones
 * confirmadas (§31): lo pendiente de confirmar se informa, no se mezcla.
 */
export default async function ShoppingPage({ searchParams }: Props) {
  const { semana } = await searchParams;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/shopping");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <main className="mx-auto max-w-3xl px-4 pb-16">
        <AppNav active="shopping" />
        <h1 className="mb-2 mt-2 text-2xl font-semibold">Compras</h1>
        <p className="rounded-2xl border border-dashed border-[var(--ink)]/20 p-6 text-center text-sm text-[var(--ink)]/60">
          Primero crea o únete a un hogar en la pestaña Familia.
        </p>
      </main>
    );
  }

  const { data: hogar, error: hogarError } = await supabase
    .from("households")
    .select("timezone")
    .eq("id", householdId)
    .maybeSingle();
  if (hogarError) throw new DataAccessError("zona horaria del hogar", hogarError);

  const hoy = effectiveDate(new Date(), hogar?.timezone ?? "America/Santiago");
  const inicio = semana && /^\d{4}-\d{2}-\d{2}$/.test(semana) ? weekStart(semana) : weekStart(hoy);

  const contexto = await loadShoppingContext(supabase, householdId, inicio);
  const lista = await loadShoppingList(supabase, contexto.planId);

  // ¿La planificación cambió desde la última generación? (§34)
  const firmaActual = demandSignature(contexto.input);
  const desactualizada =
    lista !== null && lista.currentRevision > 0 && lista.currentSignature !== firmaActual;

  const demandaFresca = aggregateDemand(contexto.input);
  const anterior = addDays(inicio, -7);
  const siguiente = addDays(inicio, 7);

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="shopping" />

      <header className="mb-4">
        <h1 className="text-2xl font-semibold">Compra de la semana</h1>
        <p className="mt-1 text-sm text-[var(--ink)]/60">{weekLabel(inicio)}</p>
      </header>

      <nav className="mb-5 flex items-center justify-between gap-2">
        <Link
          href={`/shopping?semana=${anterior}`}
          className="rounded-full border border-[var(--ink)]/20 px-4 py-2 text-xs font-medium"
        >
          ← Semana anterior
        </Link>
        {inicio !== weekStart(hoy) && (
          <Link href="/shopping" className="text-xs text-[var(--accent)] underline">
            Volver a esta semana
          </Link>
        )}
        <Link
          href={`/shopping?semana=${siguiente}`}
          className="rounded-full border border-[var(--ink)]/20 px-4 py-2 text-xs font-medium"
        >
          Semana siguiente →
        </Link>
      </nav>

      <ShoppingBoard
        key={inicio}
        weekStart={inicio}
        lista={lista}
        unconfirmed={contexto.unconfirmed}
        desactualizada={desactualizada}
        demandaDisponible={demandaFresca.length > 0}
      />
    </main>
  );
}
