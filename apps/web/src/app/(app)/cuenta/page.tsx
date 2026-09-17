import type { Metadata } from "next";
import Link from "next/link";

import { BadgeCheck, Briefcase, Gift, Star, UserRound } from "lucide-react";

import { Badge, ButtonLink, Card, CardContent } from "@/components/ui";
import { Alert } from "@/components/ui/feedback";
import { AccountModes } from "@/components/account/account-modes";
import { AvatarUploader } from "@/components/account/avatar-uploader";
import { site } from "@/config/site";
import { getViewer } from "@/lib/auth/session";
import { isDemoMode } from "@/lib/data";
import { UserRole } from "@/lib/domain/enums";
import { verificationStatusLabels } from "@/lib/domain/labels";

export const metadata: Metadata = {
  title: "Mi cuenta",
  robots: { index: false, follow: false },
};

export default async function AccountPage() {
  const session = await getViewer();

  if (!session) {
    return (
      <div className="container-page max-w-2xl py-8 sm:py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Mi cuenta</h1>
        <p className="mt-2 text-ink-600">
          Entra a tu cuenta para gestionar tu perfil, tu verificación y tus pagos. La misma cuenta
          sirve para contratar y para trabajar.
        </p>

        {isDemoMode() && (
          <Alert tone="info" className="mt-6" title="Modo demostración">
            No hay cuentas en este modo. Configura Supabase para registrarte y entrar.
          </Alert>
        )}

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <ButtonLink href="/entrar">Entrar</ButtonLink>
          <ButtonLink href="/crear-cuenta" variant="outline">
            Crear cuenta
          </ButtonLink>
        </div>
      </div>
    );
  }

  const isWorker = session.modes.includes(UserRole.WORKER);
  const verification = session.worker
    ? verificationStatusLabels[session.worker.verificationStatus]
    : null;

  return (
    <div className="container-page max-w-3xl py-8 sm:py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">Mi cuenta</h1>
      <p className="mt-2 text-ink-600">
        {session.profile.displayName} · {session.email}
      </p>

      <Card className="mt-8">
        <CardContent>
          <h2 className="font-semibold text-ink-900">Tu fotografía</h2>
          <p className="mt-1.5 text-sm text-ink-600">
            Es lo primero que ve la otra persona. Un perfil con foto recibe más respuestas.
          </p>
          <div className="mt-5">
            <AvatarUploader
              userId={session.id}
              displayName={session.profile.displayName}
              currentUrl={session.profile.avatarUrl}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardContent>
          <h2 className="flex items-center gap-2 font-semibold text-ink-900">
            <UserRound size={18} className="text-brand-600" aria-hidden="true" />
            Cómo usas HagoTuFila
          </h2>
          <p className="mt-1.5 text-sm text-ink-600">
            Una sola cuenta para los dos modos. Cambiarlo no borra nada de lo que ya hiciste.
          </p>
          <div className="mt-5">
            <AccountModes
              isClient={session.modes.includes(UserRole.CLIENT)}
              isWorker={isWorker}
            />
          </div>
        </CardContent>
      </Card>

      {isWorker && (
        <Card className="mt-5">
          <CardContent>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="flex items-center gap-2 font-semibold text-ink-900">
                  <BadgeCheck size={18} className="text-brand-600" aria-hidden="true" />
                  Perfil de trabajador
                </h2>
                <p className="mt-1.5 text-sm text-ink-600">
                  Tu tarifa, tus zonas de trabajo y tu verificación de identidad.
                </p>
                {verification && (
                  <Badge tone={verification.tone} className="mt-3">
                    {verification.label}
                  </Badge>
                )}
              </div>
              <ButtonLink href="/cuenta/trabajador" variant="outline" size="sm">
                Gestionar
              </ButtonLink>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <QuickLink
          href="/mis-trabajos/publicados"
          icon={<Briefcase size={18} aria-hidden="true" />}
          title="Trabajos que publiqué"
          description="Ofertas recibidas, asignados y terminados."
        />
        <QuickLink
          href={isWorker ? "/mis-trabajos" : "/trabajar"}
          icon={<Star size={18} aria-hidden="true" />}
          title={isWorker ? "Mis trabajos" : "Quiero ganar dinero"}
          description={
            isWorker
              ? "Tus ofertas enviadas y tus trabajos asignados."
              : "Activa el modo trabajador y empieza a ofertar."
          }
        />
        <QuickLink
          href={`/trabajadores/${session.id}`}
          icon={<UserRound size={18} aria-hidden="true" />}
          title="Ver mi perfil público"
          description="Lo que ven los demás. Nunca incluye tus datos privados."
        />
        <QuickLink
          href="/notificaciones"
          icon={<Gift size={18} aria-hidden="true" />}
          title={site.loyaltyLabel}
          description="Tus puntos y avisos de la plataforma."
        />
      </div>
    </div>
  );
}

function QuickLink({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link href={href} className="block">
      <Card className="h-full transition-colors hover:border-brand-200">
        <CardContent>
          <span className="text-brand-600">{icon}</span>
          <h3 className="mt-3 font-semibold text-ink-900">{title}</h3>
          <p className="mt-1 text-sm text-ink-600">{description}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
