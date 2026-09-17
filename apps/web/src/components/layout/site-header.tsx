import Link from "next/link";

import { Bell, MessageCircle } from "lucide-react";

import { ButtonLink } from "@/components/ui";
import { site } from "@/config/site";
import { getSession } from "@/lib/auth/session";
import { UserRole } from "@/lib/domain/enums";

import { Logo } from "./logo";
import { MobileMenu } from "./mobile-menu";
import { UserMenu } from "./user-menu";

const navigation = [
  { href: "/trabajos", label: "Buscar trabajos" },
  { href: "/como-funciona", label: "Cómo funciona" },
  { href: "/trabajadores", label: "Trabajadores" },
  { href: "/precios", label: "Precios" },
];

/**
 * Cabecera.
 *
 * Es un componente de servidor para que la sesión se resuelva antes de pintar:
 * así nadie ve "Entrar" durante un instante estando ya conectado.
 */
export async function SiteHeader() {
  const session = await getSession();
  const isWorker = session?.modes.includes(UserRole.WORKER) ?? false;

  return (
    <header className="sticky top-0 z-40 border-b border-ink-200/70 bg-white/85 backdrop-blur-md">
      <div className="container-page flex h-16 items-center justify-between gap-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label={site.name}>
          <Logo />
        </Link>

        <nav aria-label="Principal" className="hidden items-center gap-1 lg:flex">
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          {session ? (
            <>
              <Link
                href="/mensajes"
                aria-label="Mensajes"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-600 hover:bg-ink-100"
              >
                <MessageCircle size={19} aria-hidden="true" />
              </Link>

              <Link
                href="/notificaciones"
                aria-label={
                  session.unreadNotifications > 0
                    ? `Notificaciones, ${session.unreadNotifications} sin leer`
                    : "Notificaciones"
                }
                className="relative inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-600 hover:bg-ink-100"
              >
                <Bell size={19} aria-hidden="true" />
                {session.unreadNotifications > 0 && (
                  <span className="absolute top-1.5 right-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-danger-600 px-1 text-[0.625rem] font-semibold text-white tabular-nums">
                    {session.unreadNotifications > 9 ? "9+" : session.unreadNotifications}
                  </span>
                )}
              </Link>

              <ButtonLink href="/publicar" size="sm">
                Publicar
              </ButtonLink>

              <UserMenu
                displayName={session.profile.displayName}
                avatarUrl={session.profile.avatarUrl}
                isWorker={isWorker}
                isAdmin={session.isAdmin}
              />
            </>
          ) : (
            <>
              <ButtonLink href="/entrar" variant="ghost" size="sm">
                Entrar
              </ButtonLink>
              <ButtonLink href="/publicar" size="sm">
                Publicar un trabajo
              </ButtonLink>
            </>
          )}
        </div>

        <MobileMenu
          items={navigation}
          signedIn={Boolean(session)}
          unreadCount={session?.unreadNotifications ?? 0}
        />
      </div>
    </header>
  );
}
