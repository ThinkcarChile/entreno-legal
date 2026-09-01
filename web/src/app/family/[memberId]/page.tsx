import { uuidParam } from "@/lib/route-params";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import { Card, Chip, Icon } from "@/components/ui";
import { firstMeal } from "@/domain/nutrition/profile";
import { TRACKING_LABELS } from "@/domain/nutrition/types";
import { MEAL_TYPE_LABELS } from "@/domain/recipes/types";
import { effectiveDate } from "@/domain/nutrition/calendar";
import {
  loadMemberProfile,
  loadPreferenceContext,
  loadUpcomingOverrides,
} from "../nutrition-queries";
import { MemberNutritionEditor } from "./MemberNutritionEditor";
import { PreferencesEditor } from "./PreferencesEditor";
import { MemberNameEditor } from "./MemberNameEditor";
import { DailyOverrideEditor } from "./DailyOverrideEditor";
import { DataAccessError } from "@/lib/supabase/unwrap";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ memberId: string }>;
}

/** El seguimiento apagado no es un error: se dice con su propio color y texto. */
const TONO_TRACKING = {
  OFF: "neutro",
  BASIC: "info",
  FULL: "primario",
} as const;

export default async function MemberPage({ params }: Props) {
  const { memberId: memberIdCrudo } = await params;
  const memberId = uuidParam(memberIdCrudo);

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/family/${memberId}`);

  // El `household_id` viene en la MISMA consulta que trae al integrante: acá
  // había una segunda consulta idéntica metida dentro del `.eq("id", …)` de más
  // abajo, con un `?? ""` de remate. Ese relleno no era "sin hogar": contra una
  // columna uuid es un 22P02, y un integrante siempre tiene hogar
  // (`household_id` es NOT NULL desde 0001). Si el integrante no aparece, la
  // pantalla es un 404, no un hogar cualquiera.
  const { data: member, error: err1Member } = await supabase
    .from("household_members")
    .select("id, display_name, household_id")
    .eq("id", memberId)
    .maybeSingle();
  if (err1Member) throw new DataAccessError("integrante", err1Member);
  if (!member) notFound();

  // La zona horaria es del HOGAR: a las 22:30 en Santiago todavía es hoy,
  // aunque en UTC ya sea mañana.
  const { data: household, error: householdError } = await supabase
    .from("households")
    .select("timezone")
    .eq("id", member.household_id)
    .maybeSingle();
  if (householdError) throw new DataAccessError("zona horaria del hogar", householdError);
  const hoy = effectiveDate(new Date(), household?.timezone ?? "America/Santiago");

  const [profile, preferenceContext, overrides] = await Promise.all([
    loadMemberProfile(supabase, member.id, member.display_name),
    loadPreferenceContext(supabase, member.id),
    loadUpcomingOverrides(supabase, member.id, hoy),
  ]);
  const primera = firstMeal(profile);

  return (
    <AppShell active="family" title={member.display_name} subtitle="Perfil del integrante">
      <div className="mt-md">
        <Link
          href="/family"
          className="inline-flex items-center gap-xs font-body-sm text-body-sm font-semibold text-primary"
        >
          <Icon name="arrow_back" className="text-[18px]" />
          Familia
        </Link>
      </div>

      <Card className="mt-md flex flex-wrap items-center gap-md p-md">
        <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-primary-fixed font-headline-lg text-headline-lg text-on-primary-fixed">
          {member.display_name.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-1">
            <Chip tono={TONO_TRACKING[profile.trackingMode]} icon="monitor_heart">
              {TRACKING_LABELS[profile.trackingMode]}
            </Chip>
            {primera && (
              <Chip icon="schedule">primera comida: {MEAL_TYPE_LABELS[primera]}</Chip>
            )}
            {profile.version > 0 && <Chip icon="history">perfil v{profile.version}</Chip>}
          </div>
          <div className="mt-sm">
            <MemberNameEditor memberId={member.id} displayName={member.display_name} />
          </div>
        </div>
      </Card>

      <div className="mt-lg space-y-lg">
        <MemberNutritionEditor
          memberId={member.id}
          memberName={member.display_name}
          profile={profile}
        />

        <DailyOverrideEditor memberId={member.id} today={hoy} existing={overrides} />

        <PreferencesEditor
          memberId={member.id}
          memberName={member.display_name}
          context={preferenceContext}
        />
      </div>
    </AppShell>
  );
}
