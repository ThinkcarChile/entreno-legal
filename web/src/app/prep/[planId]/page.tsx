import { uuidParam } from "@/lib/route-params";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { loadHouseholdMembers } from "@/app/family/nutrition-queries";
import { loadPrepPlan } from "../queries";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { z } from "zod";
import { parseRows, uuid } from "@/lib/supabase/rows";
import { StepMode } from "./StepMode";

export const dynamic = "force-dynamic";

/** /prep/[planId] (§16): modo cocina — un paso por vez, grande, de pie. */
export default async function PrepPlanPage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId: planIdCrudo } = await params;
  const planId = uuidParam(planIdCrudo);
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/prep`);

  const { householdId } = await loadHouseholdMembers(supabase);
  if (!householdId) redirect("/family");

  const plan = await loadPrepPlan(supabase, planId);
  if (!plan) notFound();

  const { data: locData, error: locError } = await supabase
    .from("storage_locations")
    .select("id, name, kind")
    .eq("household_id", householdId)
    .order("sort_order");
  if (locError) throw new DataAccessError("ubicaciones", locError);
  const locations = parseRows(
    z.object({ id: uuid, name: z.string(), kind: z.enum(["PANTRY", "FRIDGE", "FREEZER", "OTHER"]) }),
    locData,
    "ubicaciones",
  );

  return <StepMode plan={plan} locations={locations} />;
}
