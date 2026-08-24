import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { acceptInvitation } from "./actions";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  }

  return (
    <main className="pt-16">
      <h1 className="text-3xl font-bold">Invitación al hogar</h1>
      <p className="mt-1 text-sm opacity-70">
        Te invitaron a unirte a un hogar en Mesa Familiar.
      </p>
      <form action={acceptInvitation} className="mt-6 flex flex-col gap-3">
        <input type="hidden" name="token" value={token} />
        <label className="text-sm font-medium" htmlFor="displayName">
          Tu nombre
        </label>
        <input
          id="displayName"
          name="displayName"
          required
          className="rounded-xl border border-gray-300 bg-white px-4 py-3"
        />
        <button className="mt-2 rounded-xl bg-[var(--accent)] px-4 py-3 font-semibold text-white">
          Unirme al hogar
        </button>
      </form>
    </main>
  );
}
