import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Logo } from "@/components/layout/logo";
import { Button } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { site } from "@/config/site";
import { authLinkErrorPath, confirmLinkCopy, parseConfirmLink } from "@/lib/auth/email-link";
import { hasSupabaseCredentials } from "@/lib/env";
import { getCurrentUser } from "@/lib/supabase/server";

import { confirmEmailLinkAction } from "./actions";

export const metadata: Metadata = {
  title: "Confirmar enlace",
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Enlaces de correo con `token_hash`: confirmar la cuenta, crear una
 * contraseña nueva, confirmar un cambio de correo.
 *
 * Abrir el enlace NO lo verifica: esta página explica qué va a pasar y el
 * botón «Continuar» envía el formulario a `confirmEmailLinkAction`, que llama a
 * `verifyOtp`. Antes un `GET` verificaba y abría la sesión de inmediato: un
 * enlace que otra persona pidió para su propia cuenta dejaba a quien lo abría
 * dentro de esa cuenta, sin aviso, y un filtro de correo que «revisa» los
 * enlaces los gastaba antes de que llegaran. Ver `lib/auth/email-link.ts`.
 *
 * A diferencia de `/auth/callback`, no depende de nada guardado en el
 * navegador que pidió el correo: funciona abierto desde otro navegador, desde
 * la app de correo o desde otro dispositivo. Para que los correos traigan este
 * enlace hay que cambiar las plantillas en el panel de Supabase
 * (`docs/DESPLIEGUE-SUPABASE.md` §4.1.c).
 */
export default async function ConfirmLinkPage({ searchParams }: PageProps) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const key of ["token_hash", "type", "next"]) {
    const value = raw[key];
    if (typeof value === "string") params.set(key, value);
  }

  // Un enlace roto se explica en la pantalla de siempre; redirigir no lo gasta.
  const link = parseConfirmLink(params);
  if (!link.ok) redirect(authLinkErrorPath(link.type, "enlace-invalido"));
  if (!hasSupabaseCredentials) redirect(authLinkErrorPath(link.type, "auth"));

  // Con una sesión abierta en este navegador, continuar la reemplaza por la de
  // la cuenta del enlace: se dice antes, con el correo de la que se cierra.
  const current = await getCurrentUser();
  const copy = confirmLinkCopy(link.type);

  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="container-page flex h-16 items-center">
        <Link href="/" aria-label={site.name}>
          <Logo />
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-5 py-8 sm:items-center sm:py-12">
        <div className="w-full max-w-md">
          <h1 className="text-h2 text-ink-950">{copy.title}</h1>
          <p className="mt-2 text-ink-600">{copy.body}</p>

          {current && (
            <Alert tone="warning" className="mt-6" title="Ya tienes una sesión abierta">
              Entraste como {current.email ?? "otra cuenta"}. Si continúas, esa sesión se cierra
              y entras con la cuenta de este enlace.
            </Alert>
          )}

          <form action={confirmEmailLinkAction} className="mt-8">
            <input type="hidden" name="token_hash" value={link.tokenHash} />
            <input type="hidden" name="type" value={link.type} />
            <input type="hidden" name="next" value={link.next} />
            <Button type="submit" size="lg" fullWidth>
              {copy.button}
            </Button>
          </form>

          <p className="mt-6 text-center text-small text-ink-500">
            <Link href="/" className="font-medium underline underline-offset-2">
              No continuar
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
