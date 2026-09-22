import Link from "next/link";

import { Bell, MessageCircle } from "lucide-react";

import { ButtonLink } from "@/components/ui";
import { site } from "@/config/site";
import { getViewer } from "@/lib/auth/session";
import { UserRole } from "@/lib/domain/enums";

import { Logo } from "./logo";
import { MobileMenu } from "./mobile-menu";
import { UserMenu } from "./user-menu";

/**
 * Navegación pública.
 *
 * Cuatro entradas y ninguna más: una barra con ocho enlaces es una barra que no
 * se lee. Lo que no está aquí está en el pie, que es donde se busca.
 */
const navigation = [
  { href: "/trabajos", label: "Explorar trabajos" },
  { href: "/como-funciona", label: "Cómo funciona" },
  { href: "/pago-protegido", label: "Seguridad" },
  { href: "/precios", label: "Precios" },
];

/**
 * Cabecera.
 *
 * Es un componente de servidor para que la sesión se resuelva antes de pintar:
 * así nadie ve «Entrar» durante un instante estando ya conectado.
 *
 * En móvil quedan el logotipo, los avisos y el menú. Las acciones de trabajo
 * viven en la barra inferior, que es donde llega el pulgar.
 */
export async function SiteHeader() {
  const session = await getViewer();
  const isWorker = session?.modes.includes(UserRole.WORKER) ?? false;
  const unread = session?.unreadNotifications ?? 0;

  return (
    <header className="sticky top-0 z-(--z-index-header) border-b border-line bg-surface/90 backdrop-blur-md">
      <div className="container-page flex h-(--spacing-header) items-center justify-between gap-4">
        <Link
          href="/"
          className="flex shrink-0 items-center rounded-[var(--radius-control)]"
          aria-label={`${site.name}, ir al inicio`}
        >
          <Logo />
        </Link>

        <nav aria-label="Principal" className="hidden items-center gap-0.5 lg:flex">
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-[var(--radius-control)] px-3 py-2 text-small font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-950"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          {session && (
            <>
              <Link
                href="/mensajes"
                aria-label="Mensajes"
                className="hidden h-11 w-11 items-center justify-center rounded-[var(--radius-control)] text-ink-600 hover:bg-ink-100 hover:text-ink-950 lg:inline-flex"
              >
                <MessageCircle size={19} aria-hidden="true" />
              </Link>

              <Link
                href="/notificaciones"
                aria-label={
                  unread > 0 ? `Notificaciones, ${unread} sin leer` : "Notificaciones"
                }
                className="relative hidden h-11 w-11 items-center justify-center rounded-[var(--radius-control)] text-ink-600 hover:bg-ink-100 hover:text-ink-950 lg:inline-flex"
              >
                <Bell size={19} aria-hidden="true" />
                {unread > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute top-1.5 right-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-danger-600 px-1 text-[0.625rem] leading-4 font-semibold text-white"
                  >
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </Link>
            </>
          )}

          {session ? (
            <div className="hidden lg:flex lg:items-center lg:gap-2">
              <ButtonLink href="/publicar" size="sm">
                Publicar trabajo
              </ButtonLink>
              <UserMenu
                displayName={session.profile.displayName}
                avatarUrl={session.profile.avatarUrl}
                isWorker={isWorker}
                isAdmin={session.isAdmin}
              />
            </div>
          ) : (
            <div className="hidden lg:flex lg:items-center lg:gap-2">
              <ButtonLink href="/entrar" variant="ghost" size="sm">
                Iniciar sesión
              </ButtonLink>
              <ButtonLink href="/publicar" size="sm">
                Publicar trabajo
              </ButtonLink>
            </div>
          )}

          <MobileMenu
            items={navigation}
            signedIn={Boolean(session)}
            isWorker={isWorker}
            isAdmin={session?.isAdmin ?? false}
            unreadCount={unread}
          />
        </div>
      </div>
    </header>
  );
}
