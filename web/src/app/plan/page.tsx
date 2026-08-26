import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Chip, EmptyState, Icon, LinkButton, Notice } from "@/components/ui";
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

  const { householdId, members } = await loadHouseholdMembers(supabase);
  if (!householdId) {
    return (
      <AppShell active="plan" title="Semana">
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
    <AppShell active="plan" title="Semana" subtitle={weekLabel(inicio)}>
      <div className="mt-md flex flex-wrap items-center gap-sm">
        <Chip icon="event_note">{planificadas} comidas planificadas</Chip>
        {confirmadas > 0 && (
          <Chip tono="primario" icon="check_circle">
            {confirmadas} confirmadas
          </Chip>
        )}
      </div>

      {/* Navegar entre semanas. En 320 px los dos botones envuelven antes de
          desbordar: la barra nunca empuja la página a lo ancho. */}
      <nav className="mt-md mb-lg flex flex-wrap items-center justify-between gap-sm">
        <LinkButton href={`/plan?semana=${anterior}`} variant="outline">
          <Icon name="chevron_left" className="text-[18px]" />
          Semana anterior
        </LinkButton>
        {inicio !== weekStart(hoy) && (
          <Link
            href="/plan"
            className="font-body-sm text-body-sm font-semibold text-primary underline"
          >
            Volver a esta semana
          </Link>
        )}
        <LinkButton href={`/plan?semana=${siguiente}`} variant="outline">
          Semana siguiente
          <Icon name="chevron_right" className="text-[18px]" />
        </LinkButton>
      </nav>

      {recipes.length === 0 && (
        <div className="mb-lg">
          <Notice icon="menu_book">
            Todavía no hay recetas publicadas para planificar. Publica una en la pestaña Recetas.
          </Notice>
        </div>
      )}

      <WeekBoard
        week={week}
        recipes={recipes}
        members={members.map((m) => ({ id: m.id, name: m.displayName }))}
        today={hoy}
      />
    </AppShell>
  );
}
