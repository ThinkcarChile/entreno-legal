import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { Button, Card, Icon } from "@/components/ui";
import { acceptInvitation } from "./actions";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

/**
 * Aceptar una invitación: una sola columna centrada, sin navegación. Quien
 * llega acá todavía no pertenece a ningún hogar, así que no hay a dónde ir —
 * mostrarle un menú de pestañas sería ofrecerle puertas cerradas.
 *
 * El ancho va explícito (`max-w-[24rem]`) a propósito: las utilidades de ancho
 * con sufijo corto chocan con la escala de espaciado del kit y resuelven a
 * píxeles sueltos en vez de rem (ver globals.css y anchos-colisionados.test).
 */
const CAMPO =
  "w-full min-h-[48px] rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-3 font-body-md text-body-md text-on-surface";

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
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-container-margin py-xl">
      <div className="w-full max-w-[24rem]">
        <div className="flex flex-col items-center text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-fixed text-on-primary-fixed">
            <Icon name="group_add" className="text-[32px]" />
          </span>
          <h1 className="mt-md font-headline-lg-mobile text-headline-lg-mobile text-primary">
            Invitación al hogar
          </h1>
          <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
            {/* Esta línea la lee alguien que todavía no conoce la app: si la
                marca de acá no es la del manifiesto, la invitación parece de
                otro producto. Lo vigila pwa-coherencia.test.ts. */}
            Te invitaron a unirte a un hogar en NutriFamilia.
          </p>
        </div>

        <Card className="mt-lg">
          <form action={acceptInvitation} className="space-y-md p-md">
            <input type="hidden" name="token" value={token} />
            <label className="block">
              <span className="mb-1 block font-body-sm text-body-sm font-semibold text-on-surface">
                Tu nombre
              </span>
              <input
                id="displayName"
                name="displayName"
                required
                autoComplete="name"
                className={CAMPO}
              />
              <span className="mt-1 block font-body-sm text-body-sm text-on-surface-variant">
                Así te va a ver el resto de la familia.
              </span>
            </label>
            <Button type="submit" full>
              <Icon name="group_add" className="text-[18px]" />
              Unirme al hogar
            </Button>
          </form>
        </Card>
      </div>
    </main>
  );
}
