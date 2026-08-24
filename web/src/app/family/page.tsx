import Link from "next/link";
import { DemoFamilyButton } from "./DemoFamilyButton";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { signOut } from "@/app/login/actions";
import { AppNav } from "@/components/AppNav";
import { createHousehold, createInvitation } from "./actions";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ error?: string; invite?: string }>;
}

interface MemberRow {
  id: string;
  display_name: string;
  user_id: string | null;
  is_active: boolean;
  member_role_assignments: { household_roles: { code: string; name: string } | null }[];
}

export default async function FamilyPage({ searchParams }: Props) {
  const { error, invite } = await searchParams;
  const supabase = await createSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?next=/family");
  }

  const { data: membership } = await supabase
    .from("household_members")
    .select("household_id, households(name)")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (!membership) {
    return (
      <main className="pt-2">
        <AppNav active="family" />
        <h1 className="text-3xl font-bold">Crea tu hogar</h1>
        <p className="mt-1 text-sm opacity-70">
          Tu familia parte aquí. Después podrás invitar a los demás integrantes.
        </p>
        {error ? <Alert text={error} /> : null}
        <form action={createHousehold} className="mt-6 flex flex-col gap-3">
          <label className="text-sm font-medium" htmlFor="householdName">
            Nombre del hogar
          </label>
          <input
            id="householdName"
            name="householdName"
            required
            placeholder="Familia X"
            className="rounded-xl border border-gray-300 bg-white px-4 py-3"
          />
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
            Crear hogar
          </button>
        </form>
        <SignOutButton />
      </main>
    );
  }

  const householdName =
    (membership.households as unknown as { name: string } | null)?.name ?? "Mi hogar";

  const { data: members, error: membersError } = await supabase
    .from("household_members")
    .select(
      // Dos claves foráneas apuntan de member_role_assignments a household_members
      // (member_id y granted_by): PostgREST exige decir por cuál se navega.
      `id, display_name, user_id, is_active,
       member_role_assignments!member_role_assignments_member_id_fkey (
         household_roles ( code, name )
       )`,
    )
    .eq("household_id", membership.household_id)
    .order("created_at");

  // Una lista vacía por error de consulta se ve igual que un hogar sin gente:
  // exactamente la trampa que ya nos costó horas en el recetario.
  if (membersError) {
    throw new Error(`No se pudo leer el hogar (${membersError.code}): ${membersError.message}`);
  }

  return (
    <main className="pt-2">
      <AppNav active="family" />
      <h1 className="text-3xl font-bold">{householdName}</h1>
      <p className="mt-1 text-sm opacity-70">Integrantes del hogar</p>
      {error ? <Alert text={error} /> : null}
      {invite ? <InviteLink token={invite} /> : null}

      <ul className="mt-6 flex flex-col gap-2">
        {((members ?? []) as unknown as MemberRow[]).map((m) => (
          <li key={m.id} className="rounded-xl border border-gray-200 bg-white px-4 py-3">
            <div className="flex items-center justify-between">
              <Link href={`/family/${m.id}`} className="font-semibold text-[var(--accent)]">
                {m.display_name}
              </Link>
              {!m.user_id ? <span className="text-xs opacity-60">sin cuenta</span> : null}
            </div>
            <p className="mt-0.5 text-xs opacity-60">Tocar para ver su alimentación</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {m.member_role_assignments.map((a) =>
                a.household_roles ? (
                  <span
                    key={a.household_roles.code}
                    className="rounded-full bg-[color-mix(in_srgb,var(--accent)_12%,white)] px-2 py-0.5 text-xs text-[var(--accent)]"
                  >
                    {a.household_roles.name}
                  </span>
                ) : null,
              )}
            </div>
          </li>
        ))}
      </ul>

      <DemoFamilyButton householdId={membership.household_id} />

      <section className="mt-8 rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="font-semibold">Invitar integrante</h2>
        <p className="mt-1 text-xs opacity-70">
          Genera un link de invitación de un solo uso (válido 7 días). Solo administradores.
        </p>
        <form action={createInvitation} className="mt-3 flex flex-col gap-2">
          <input type="hidden" name="householdId" value={membership.household_id} />
          <input
            name="email"
            type="email"
            placeholder="Correo (opcional)"
            className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm"
          />
          <select name="roleCode" className="rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm">
            <option value="MEMBER">Integrante</option>
            <option value="PLANNER">Planificador</option>
            <option value="SHOPPER">Comprador</option>
            <option value="COOK">Cocinero</option>
            <option value="ADMIN">Administrador familiar</option>
          </select>
          <button className="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white">
            Generar invitación
          </button>
        </form>
      </section>

      <SignOutButton />
    </main>
  );
}

function Alert({ text }: { text: string }) {
  return (
    <p className="mt-4 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800" role="alert">
      {text}
    </p>
  );
}

function InviteLink({ token }: { token: string }) {
  const path = `/invite/${token}`;
  return (
    <div className="mt-4 rounded-lg border border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,white)] px-3 py-2 text-sm">
      <p className="font-semibold">Invitación creada</p>
      <p className="mt-1 break-all">
        Comparte este link (se muestra una sola vez): <code>{path}</code>
      </p>
    </div>
  );
}

function SignOutButton() {
  return (
    <form action={signOut} className="mt-10">
      <button className="text-sm underline opacity-60">Cerrar sesión</button>
    </form>
  );
}
