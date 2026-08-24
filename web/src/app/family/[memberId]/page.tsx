import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { AppNav } from "@/components/AppNav";
import { firstMeal } from "@/domain/nutrition/profile";
import { TRACKING_LABELS } from "@/domain/nutrition/types";
import { MEAL_TYPE_LABELS } from "@/domain/recipes/types";
import { loadMemberProfile } from "../nutrition-queries";
import { MemberNutritionEditor } from "./MemberNutritionEditor";

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

  const { data: member } = await supabase
    .from("household_members")
    .select("id, display_name")
    .eq("id", memberId)
    .maybeSingle();
  if (!member) notFound();

  const profile = await loadMemberProfile(supabase, member.id, member.display_name);
  const primera = firstMeal(profile);

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16">
      <AppNav active="family" />
      <Link href="/family" className="text-sm text-[var(--accent)]">
        ← Familia
      </Link>

      <header className="mb-4 mt-2">
        <h1 className="text-2xl font-semibold">{member.display_name}</h1>
        <p className="mt-1 text-sm text-[var(--ink)]/60">
          {TRACKING_LABELS[profile.trackingMode]}
          {primera && <> · primera comida: {MEAL_TYPE_LABELS[primera]}</>}
          {profile.version > 0 && <> · perfil v{profile.version}</>}
        </p>
      </header>

      <MemberNutritionEditor
        memberId={member.id}
        memberName={member.display_name}
        profile={profile}
      />
    </main>
  );
}
