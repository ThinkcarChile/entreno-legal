import Link from "next/link";
import { Card, ErrorNote, Icon, Notice } from "@/components/ui";
import { avisoDe } from "@/lib/auth/avisos";
import { solicitarRecuperacion } from "./actions";

interface Props {
  searchParams: Promise<{ aviso?: string }>;
}

/**
 * "Olvidé mi contraseña": un correo, un botón. Sin sesión a propósito — quien
 * llega acá es porque no puede entrar.
 *
 * El aviso de "te mandamos el enlace" se muestra igual exista o no el correo:
 * ver `actions.ts`.
 */
const CAMPO =
  "w-full min-h-[48px] rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-3 font-body-md text-body-md text-on-surface";

export default async function RecuperarPage({ searchParams }: Props) {
  const { aviso } = await searchParams;
  const mensaje = avisoDe(aviso);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-container-margin py-xl">
      <div className="w-full max-w-[24rem]">
        <div className="flex flex-col items-center text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-fixed text-on-primary-fixed">
            <Icon name="lock_reset" className="text-[32px]" />
          </span>
          <h1 className="mt-md font-headline-lg-mobile text-headline-lg-mobile text-primary">
            Recuperar contraseña
          </h1>
          <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
            Te mandamos un enlace a tu correo para elegir una clave nueva.
          </p>
        </div>

        {mensaje ? (
          <div className="mt-md">
            {mensaje.tono === "error" ? (
              <ErrorNote>{mensaje.texto}</ErrorNote>
            ) : (
              <Notice icon="mark_email_read" tono="info">
                {mensaje.texto}
              </Notice>
            )}
          </div>
        ) : null}

        <Card className="mt-lg">
          <form action={solicitarRecuperacion} className="space-y-md p-md">
            <label className="block">
              <span className="mb-1 block font-body-sm text-body-sm font-semibold text-on-surface">
                Correo
              </span>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                className={CAMPO}
              />
            </label>
            <button
              type="submit"
              className="inline-flex w-full items-center justify-center gap-sm rounded-full bg-primary px-lg py-3 font-body-md text-body-md font-semibold text-on-primary transition-transform active:scale-95"
            >
              <Icon name="send" className="text-[18px]" />
              Mandar el enlace
            </button>
          </form>
        </Card>

        <p className="mt-md text-center font-body-sm text-body-sm">
          <Link href="/login" className="text-primary underline underline-offset-4">
            Volver a entrar
          </Link>
        </p>
      </div>
    </main>
  );
}
