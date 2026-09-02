import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { EmptyState, Icon, LinkButton } from "@/components/ui";
import { addDays, effectiveDate, weekLabel, weekStart } from "@/domain/nutrition/calendar";
import { aggregateDemand, demandSignature } from "@/domain/shopping/engine";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { loadShoppingContext, loadShoppingList } from "./queries";
import { cargarRelevosDeEventos } from "@/app/demanda-abierta";
import { loadAvailableLots } from "@/app/pantry/queries";
import { expiryInfo, stockByIngredient } from "@/domain/inventory/fefo";
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

  const { householdId, members } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="shopping" title="Compras">
        <div className="mt-md">
          <EmptyState icon="group_add">
            Primero crea o únete a un hogar en la pestaña Familia.
          </EmptyState>
        </div>
      </AppShell>
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

  // Descuento en compra (Sprint 7): cuánto de cada alimento YA está en casa.
  // Es un dato informativo junto a la línea — la demanda calculada no se toca.
  const idsDeLista = [
    ...new Set((lista?.items ?? []).map((i) => i.ingredientId).filter(Boolean)),
  ] as string[];
  const lotes = await loadAvailableLots(supabase, householdId, idsDeLista);
  // Un lote vencido no cuenta como "lo tienes en casa": sugerir no comprar
  // basándose en comida vencida sería mentir dos veces.
  const vigentes = lotes.filter((l) => expiryInfo(l, hoy).state !== "EXPIRED");
  const stock = Object.fromEntries(stockByIngredient(vigentes));

  // ¿La planificación cambió desde la última generación? (§34)
  const firmaActual = demandSignature(contexto.input);
  const desactualizada =
    lista !== null && lista.currentRevision > 0 && lista.currentSignature !== firmaActual;

  const demandaFresca = aggregateDemand(contexto.input);

  // H20: lo que esta semana NO se compra porque hay un evento. Se lee aparte de
  // la lista a propósito: la lista dice qué comprar y esto dice qué se dejó de
  // comprar y por qué. Sin la segunda mitad, el relevo es una lista más corta
  // sin explicación, y una lista más corta sin explicación se compra igual.
  const relevos = await cargarRelevosDeEventos(
    supabase,
    members.map((m) => m.id),
    inicio,
    addDays(inicio, 6),
  );

  const anterior = addDays(inicio, -7);
  const siguiente = addDays(inicio, 7);

  return (
    <AppShell active="shopping" title="Compra de la semana" subtitle={weekLabel(inicio)}>
      <nav className="mt-md flex items-center justify-between gap-sm">
        <LinkButton href={`/shopping?semana=${anterior}`} variant="outline">
          <Icon name="chevron_left" className="text-[18px]" />
          Anterior
        </LinkButton>
        {inicio !== weekStart(hoy) && (
          <Link
            href="/shopping"
            className="min-w-0 truncate font-body-sm text-body-sm font-semibold text-primary underline underline-offset-2"
          >
            Volver a esta semana
          </Link>
        )}
        <LinkButton href={`/shopping?semana=${siguiente}`} variant="outline">
          Siguiente
          <Icon name="chevron_right" className="text-[18px]" />
        </LinkButton>
      </nav>

      <ShoppingBoard
        key={inicio}
        weekStart={inicio}
        lista={lista}
        unconfirmed={contexto.unconfirmed}
        relevos={relevos}
        desactualizada={desactualizada}
        demandaDisponible={demandaFresca.length > 0}
        stock={stock}
      />
    </AppShell>
  );
}
