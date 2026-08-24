import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import { addDays, effectiveDate, weekLabel, weekStart } from "@/domain/nutrition/calendar";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { loadPlannableRecipes, loadWeek } from "./queries";
import { WeekBoard } from "./WeekBoard";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ semana?: string }>;
}

export default async function PlanPage({ searchParams }: Props) {
  const { semana } = await searchParams;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/plan");

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <main className="mx-auto max-w-3xl px-4 pb-16">
        <AppNav active="plan" />
        <h1 className="mb-2 mt-2 text-2xl font-semibold">Semana</h1>
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

  // La semana se ancla al día del HOGAR, no al de UTC.
  const hoy = effectiveDate(new Date(), hogar?.timezone ?? "America/Santiago");
  const inicio = semana && /^\d{4}-\d{2}-\d{2}$/.test(semana) ? weekStart(semana) : weekStart(hoy);

  const [week, recipes] = await Promise.all([
    loadWeek(supabase, householdId, inicio),
    loadPlannableRecipes(supabase),
  ]);

  const anterior = addDays(inicio, -7);
  const siguiente = addDays(inicio, 7);
  const planificadas = week.days.flatMap((d) => d.assignments).length;
  const confirmadas = week.days
    .flatMap((d) => d.assignments)
    .filter((a) => a.status === "CONFIRMED" || a.status === "SERVED").length;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="plan" />

      <header className="mb-4">
        <h1 className="text-2xl font-semibold">Semana</h1>
        <p className="mt-1 text-sm text-[var(--ink)]/60">
          {weekLabel(inicio)} · {planificadas} comidas planificadas
          {confirmadas > 0 && <> · {confirmadas} confirmadas</>}
        </p>
      </header>

      <nav className="mb-5 flex items-center justify-between gap-2">
        <Link
          href={`/plan?semana=${anterior}`}
          className="rounded-full border border-[var(--ink)]/20 px-4 py-2 text-xs font-medium"
        >
          ← Semana anterior
        </Link>
        {inicio !== weekStart(hoy) && (
          <Link href="/plan" className="text-xs text-[var(--accent)] underline">
            Volver a esta semana
          </Link>
        )}
        <Link
          href={`/plan?semana=${siguiente}`}
          className="rounded-full border border-[var(--ink)]/20 px-4 py-2 text-xs font-medium"
        >
          Semana siguiente →
        </Link>
      </nav>

      {recipes.length === 0 && (
        <p className="mb-4 rounded-xl bg-[var(--ink)]/5 px-3 py-2 text-xs text-[var(--ink)]/70">
          Todavía no hay recetas publicadas para planificar. Publica una en la pestaña Recetas.
        </p>
      )}

      <WeekBoard week={week} recipes={recipes} today={hoy} />
    </main>
  );
}
