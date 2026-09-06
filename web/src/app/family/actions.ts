"use server";

import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { createHouseholdSchema, inviteSchema } from "@/domain/family/schemas";
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiry,
} from "@/domain/family/invitations";
import { creacionDeHogarAbierta } from "./politica-hogar";
import { alFamily } from "./avisos";

export async function createHousehold(formData: FormData): Promise<void> {
  // La política se pregunta ACÁ además de en la página: una server action es
  // un POST alcanzable sin pasar por la página, y el formulario escondido no
  // cierra nada por sí solo. Ver politica-hogar.ts.
  if (!creacionDeHogarAbierta()) {
    redirect(alFamily("hogares-cerrados"));
  }
  const parsed = createHouseholdSchema.safeParse({
    householdName: formData.get("householdName"),
    displayName: formData.get("displayName"),
  });
  if (!parsed.success) {
    redirect(alFamily("datos-hogar"));
  }

  const supabase = await createSupabaseServer();
  const { error } = await supabase.rpc("create_household", {
    p_name: parsed.data.householdName,
    p_display_name: parsed.data.displayName,
  });
  if (error) {
    redirect(alFamily("no-se-creo"));
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
    redirect(alFamily("datos-invitacion"));
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
    redirect(alFamily("solo-admin"));
  }
  // El token viaja una sola vez, para compartir el link; solo su hash queda almacenado.
  redirect(`/family?invite=${encodeURIComponent(token)}`);
}
