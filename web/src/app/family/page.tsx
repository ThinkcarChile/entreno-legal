import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { DataAccessError } from "@/lib/supabase/unwrap";
import { parseRow, parseRows, uuid } from "@/lib/supabase/rows";
import { signOut } from "@/app/login/actions";
import { AppShell, ShellAction } from "@/components/AppShell";
import { KitchenShortcuts } from "@/components/KitchenShortcuts";
import {
  ButtonOutline,
  Card,
  CardLink,
  Chip,
  EmptyState,
  ErrorNote,
  Icon,
  Notice,
  Section,
} from "@/components/ui";
import { DemoFamilyButton } from "./DemoFamilyButton";
import { createHousehold, createInvitation } from "./actions";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ error?: string; invite?: string }>;
}

/**
 * Campos del kit: 48 px de alto mínimo porque esto se llena de pie en la
 * cocina, con una sola mano (§58).
 */
const CAMPO =
  "w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-3 font-body-md text-body-md text-on-surface min-h-[48px]";

const ETIQUETA = "mb-1 block font-body-sm text-body-sm font-semibold text-on-surface";

const rolEmbebido = z.object({ code: z.string(), name: z.string() });
const oneRol = z
  .union([rolEmbebido, z.array(rolEmbebido), z.null()])
  .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v));

const asignacion = z.object({ household_roles: oneRol });
const manyAsignaciones = z
  .union([z.array(asignacion), asignacion, z.null()])
  .transform((v) => (v === null ? [] : Array.isArray(v) ? v : [v]));

const memberRowSchema = z.object({
  id: uuid,
  display_name: z.string(),
  user_id: uuid.nullable(),
  is_active: z.boolean(),
  member_role_assignments: manyAsignaciones,
});

const hogarEmbebido = z.object({ name: z.string() });
const oneHogar = z
  .union([hogarEmbebido, z.array(hogarEmbebido), z.null()])
  .transform((v) => (Array.isArray(v) ? (v[0] ?? null) : v));

export default async function FamilyPage({ searchParams }: Props) {
  const { error, invite } = await searchParams;
  const supabase = await createSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?next=/family");
  }

  const { data: membership, error: membershipError } = await supabase
    .from("household_members")
    .select("household_id, households(name)")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (membershipError) throw new DataAccessError("hogar del usuario", membershipError);

  if (!membership) {
    return (
      <AppShell
        active="family"
        title="Crea tu hogar"
        subtitle="Tu familia parte aquí. Después podrás invitar a los demás integrantes."
      >
        <div className="mt-md space-y-md">
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Card as="section">
            <form action={createHousehold} className="space-y-md p-md">
              <label className="block">
                <span className={ETIQUETA}>Nombre del hogar</span>
                <input
                  id="householdName"
                  name="householdName"
                  required
                  placeholder="Familia X"
                  className={CAMPO}
                />
              </label>
              <label className="block">
                <span className={ETIQUETA}>Tu nombre</span>
                <input id="displayName" name="displayName" required className={CAMPO} />
              </label>
              <button
                type="submit"
                className="inline-flex w-full items-center justify-center gap-sm rounded-full bg-primary px-lg py-3 font-body-md text-body-md font-semibold text-on-primary transition-transform active:scale-95"
              >
                <Icon name="add_home" className="text-[18px]" />
                Crear hogar
              </button>
            </form>
          </Card>
          <CerrarSesion />
        </div>
      </AppShell>
    );
  }

  const householdName =
    parseRow(z.object({ households: oneHogar }), membership, "hogar").households?.name ??
    "Mi hogar";

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

  const integrantes = parseRows(memberRowSchema, members, "integrantes del hogar");

  return (
    <AppShell
      active="family"
      title={householdName}
      subtitle="Integrantes del hogar"
      action={
        <ShellAction href="#invitar">
          <Icon name="person_add" className="text-[18px]" />
          Invitar
        </ShellAction>
      }
    >
      {error || invite ? (
        <div className="mt-md space-y-md">
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {invite ? <InviteLink token={invite} /> : null}
        </div>
      ) : null}

      <KitchenShortcuts />

      <Section title="Integrantes" hint="Tocar para ver su alimentación">
        {integrantes.length === 0 ? (
          <EmptyState icon="group">
            Todavía no hay integrantes en este hogar. Invita a alguien con un link de un solo uso.
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-1 gap-sm sm:grid-cols-2">
            {integrantes.map((m) => (
              <li key={m.id}>
                <CardLink href={`/family/${m.id}`} className="flex items-center gap-md p-md">
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary-fixed font-headline-sm text-headline-sm text-on-primary-fixed">
                    {m.display_name.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-sm">
                      <span className="truncate font-headline-sm text-headline-sm text-on-surface">
                        {m.display_name}
                      </span>
                      {!m.user_id ? <Chip icon="person_off">sin cuenta</Chip> : null}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {m.member_role_assignments.map((a) =>
                        a.household_roles ? (
                          <Chip key={a.household_roles.code} tono="primario">
                            {a.household_roles.name}
                          </Chip>
                        ) : null,
                      )}
                    </span>
                  </span>
                  <Icon name="chevron_right" className="text-outline" />
                </CardLink>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <DemoFamilyButton householdId={membership.household_id} />

      <Section
        title="Invitar integrante"
        hint="Genera un link de invitación de un solo uso (válido 7 días). Solo administradores."
        className="mt-lg"
      >
        <Card as="section">
          <form
            action={createInvitation}
            className="scroll-mt-32 space-y-sm p-md"
            id="invitar"
          >
            <input type="hidden" name="householdId" value={membership.household_id} />
            <label className="block">
              <span className={ETIQUETA}>
                Correo <span className="font-normal text-on-surface-variant">(opcional)</span>
              </span>
              <input name="email" type="email" placeholder="correo@ejemplo.cl" className={CAMPO} />
            </label>
            <label className="block">
              <span className={ETIQUETA}>Rol en el hogar</span>
              <select name="roleCode" className={CAMPO}>
                <option value="MEMBER">Integrante</option>
                <option value="PLANNER">Planificador</option>
                <option value="SHOPPER">Comprador</option>
                <option value="COOK">Cocinero</option>
                <option value="ADMIN">Administrador familiar</option>
              </select>
            </label>
            <button
              type="submit"
              className="inline-flex w-full items-center justify-center gap-sm rounded-full bg-secondary-fixed px-lg py-3 font-body-md text-body-md font-semibold text-on-secondary-fixed-variant transition-transform active:scale-95"
            >
              <Icon name="person_add" className="text-[18px]" />
              Generar invitación
            </button>
          </form>
        </Card>
      </Section>

      <CerrarSesion />
    </AppShell>
  );
}

function InviteLink({ token }: { token: string }) {
  const path = `/invite/${token}`;
  return (
    <Notice icon="link" tono="info">
      <p className="font-semibold">Invitación creada</p>
      <p className="mt-1 break-all">
        Comparte este link (se muestra una sola vez):{" "}
        <code className="rounded bg-surface-container px-1 py-0.5 text-on-surface">{path}</code>
      </p>
    </Notice>
  );
}

function CerrarSesion() {
  return (
    <form action={signOut} className="mt-xl flex justify-center">
      <ButtonOutline type="submit">
        <Icon name="logout" className="text-[18px]" />
        Cerrar sesión
      </ButtonOutline>
    </form>
  );
}
