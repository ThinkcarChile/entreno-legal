import { redirect } from "next/navigation";
import { Card, ErrorNote, Icon } from "@/components/ui";
import { createSupabaseServer } from "@/lib/supabase/server";
import { alLogin, avisoDe } from "@/lib/auth/avisos";
import { esRecuperacionVigente, reclamacionesDe } from "@/lib/auth/recuperacion";
import { actualizarContrasena } from "./actions";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ aviso?: string }>;
}

/**
 * Elegir la clave nueva. Sólo se abre con una sesión que venga del enlace de
 * recuperación y sea reciente; con cualquier otra sesión —o sin sesión— manda al
 * login diciendo que el enlace no sirve. Ver `lib/auth/recuperacion.ts`.
 */
const CAMPO =
  "w-full min-h-[48px] rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-3 font-body-md text-body-md text-on-surface";

const ETIQUETA = "mb-1 block font-body-sm text-body-sm font-semibold text-on-surface";

export default async function NuevaContrasenaPage({ searchParams }: Props) {
  const { aviso } = await searchParams;
  const supabase = await createSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(alLogin("recuperacion-invalida"));

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session || !esRecuperacionVigente(reclamacionesDe(session.access_token))) {
    redirect(alLogin("recuperacion-invalida"));
  }

  const mensaje = avisoDe(aviso);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-container-margin py-xl">
      <div className="w-full max-w-[24rem]">
        <div className="flex flex-col items-center text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-fixed text-on-primary-fixed">
            <Icon name="key" className="text-[32px]" />
          </span>
          <h1 className="mt-md font-headline-lg-mobile text-headline-lg-mobile text-primary">
            Clave nueva
          </h1>
          <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
            Elige una clave de al menos 8 caracteres.
          </p>
        </div>

        {mensaje?.tono === "error" ? (
          <div className="mt-md">
            <ErrorNote>{mensaje.texto}</ErrorNote>
          </div>
        ) : null}

        <Card className="mt-lg">
          <form action={actualizarContrasena} className="space-y-md p-md">
            <label className="block">
              <span className={ETIQUETA}>Clave nueva</span>
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                className={CAMPO}
              />
            </label>
            <label className="block">
              <span className={ETIQUETA}>Repítela</span>
              <input
                id="confirmacion"
                name="confirmacion"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                className={CAMPO}
              />
            </label>
            <button
              type="submit"
              className="inline-flex w-full items-center justify-center gap-sm rounded-full bg-primary px-lg py-3 font-body-md text-body-md font-semibold text-on-primary transition-transform active:scale-95"
            >
              <Icon name="check" className="text-[18px]" />
              Guardar y entrar
            </button>
          </form>
        </Card>
      </div>
    </main>
  );
}
