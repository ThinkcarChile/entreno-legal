"use server";

import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { createHouseholdSchema, inviteSchema } from "@/domain/family/schemas";
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiry,
} from "@/domain/family/invitations";

export async function createHousehold(formData: FormData): Promise<void> {
  const parsed = createHouseholdSchema.safeParse({
    householdName: formData.get("householdName"),
    displayName: formData.get("displayName"),
  });
  if (!parsed.success) {
    redirect(`/family?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Datos inválidos")}`);
  }

  const supabase = await createSupabaseServer();
  const { error } = await supabase.rpc("create_household", {
    p_name: parsed.data.householdName,
    p_display_name: parsed.data.displayName,
  });
  if (error) {
    redirect(`/family?error=${encodeURIComponent("No se pudo crear el hogar")}`);
  }
  redirect("/family");
}

export async function createInvitation(formData: FormData): Promise<void> {
  const householdId = formData.get("householdId");
  const parsed = inviteSchema.safeParse({
    roleCode: formData.get("roleCode") ?? "MEMBER",
    email: formData.get("email") ?? "",
  });
  if (typeof householdId !== "string" || !parsed.success) {
    redirect(`/family?error=${encodeURIComponent("Datos de invitación inválidos")}`);
    return;
  }

  const token = generateInvitationToken();
  const supabase = await createSupabaseServer();
  const { error } = await supabase.from("invitations").insert({
    household_id: householdId,
    email: parsed.data.email,
    token_hash: hashInvitationToken(token),
    role_code: parsed.data.roleCode,
    expires_at: invitationExpiry().toISOString(),
  });
  if (error) {
    redirect(`/family?error=${encodeURIComponent("Solo el administrador puede invitar")}`);
  }
  // El token viaja una sola vez, para compartir el link; solo su hash queda almacenado.
  redirect(`/family?invite=${encodeURIComponent(token)}`);
}
