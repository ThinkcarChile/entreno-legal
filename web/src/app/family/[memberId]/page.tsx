import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
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

export default async function MemberPage({ params }: Props) {
  const { memberId } = await params;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/family/${memberId}`);

  const { data: member, error: err1Member } = await supabase
    .from("household_members")
    .select("id, display_name")
    .eq("id", memberId)
    .maybeSingle();
  if (err1Member) throw new DataAccessError("integrante", err1Member);
  if (!member) notFound();

  // La zona horaria es del HOGAR: a las 22:30 en Santiago todavía es hoy,
  // aunque en UTC ya sea mañana.
  const { data: household, error: householdError } = await supabase
    .from("households")
    .select("timezone")
    .eq("id", (await supabase.from("household_members").select("household_id").eq("id", memberId).maybeSingle()).data?.household_id ?? "")
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
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="family" />
      <Link href="/family" className="text-sm text-[var(--accent)]">
        ← Familia
      </Link>

      <header className="mb-4 mt-2">
        <MemberNameEditor memberId={member.id} displayName={member.display_name} />
        <p className="mt-1 text-sm text-[var(--ink)]/60">
          {TRACKING_LABELS[profile.trackingMode]}
          {primera && <> · primera comida: {MEAL_TYPE_LABELS[primera]}</>}
          {profile.version > 0 && <> · perfil v{profile.version}</>}
        </p>
      </header>

      <div className="space-y-5">
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
    </main>
  );
}
