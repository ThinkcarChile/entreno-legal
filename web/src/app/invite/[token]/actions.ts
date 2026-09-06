"use server";

import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { acceptInvitationSchema } from "@/domain/family/schemas";
import { hashInvitationToken } from "@/domain/family/invitations";
import { alFamily } from "@/app/family/avisos";

export async function acceptInvitation(formData: FormData): Promise<void> {
  const parsed = acceptInvitationSchema.safeParse({
    token: formData.get("token"),
    displayName: formData.get("displayName") ?? "Integrante",
  });
  if (!parsed.success) {
    redirect(alFamily("invitacion-invalida"));
    return;
  }

  const supabase = await createSupabaseServer();
  const { error } = await supabase.rpc("accept_invitation", {
    p_token_hash: hashInvitationToken(parsed.data.token),
    p_display_name: parsed.data.displayName,
  });
  if (error) {
    redirect(alFamily("invitacion-invalida"));
  }
  redirect("/family");
}
