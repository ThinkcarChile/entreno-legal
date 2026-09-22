"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import {
  Bell,
  Briefcase,
  ClipboardList,
  LifeBuoy,
  Menu,
  MessageCircle,
  Settings,
  ShieldCheck,
  User,
  Wallet,
} from "lucide-react";

import { ButtonLink, Overlay } from "@/components/ui";
import { signOutAction } from "@/lib/actions/auth";

/**
 * Menú de móvil.
 *
 * Es una hoja que sube desde abajo, no una pantalla completa sin aviso: se ve
 * de dónde viene, se cierra como se espera y el fondo sigue ahí. El
 * comportamiento —Escape, foco atrapado, foco devuelto, fondo sin desplazar— lo
 * pone `Overlay`, que es el mismo de todos los diálogos.
 *
 * Solo aparece bajo `lg`. Por encima, la navegación está en la cabecera.
 */
export function MobileMenu({
  items,
  signedIn = false,
  isWorker = false,
  isAdmin = false,
  unreadCount = 0,
}: {
  items: readonly { href: string; label: string }[];
  signedIn?: boolean;
  isWorker?: boolean;
  isAdmin?: boolean;
  unreadCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Navegar cierra el menú: si no, la hoja sigue encima de la página nueva.
  //
  // Se ajusta durante el render y no en un efecto: con un efecto, la página
  // nueva se pinta una vez con la hoja todavía abierta y luego se vuelve a
  // pintar sin ella, que es justo el parpadeo que se ve en móvil.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(false);
  }

  const personal = signedIn
    ? [
        { href: "/mis-trabajos/publicados", label: "Trabajos que publiqué", icon: Briefcase },
        ...(isWorker
          ? [
              { href: "/mis-trabajos", label: "Mis trabajos", icon: ClipboardList },
              { href: "/mis-trabajos/ganancias", label: "Mis ganancias", icon: Wallet },
            ]
          : []),
        { href: "/mensajes", label: "Mensajes", icon: MessageCircle },
        {
          href: "/notificaciones",
          label: unreadCount > 0 ? `Notificaciones (${unreadCount})` : "Notificaciones",
          icon: Bell,
        },
        { href: "/cuenta", label: "Mi cuenta", icon: Settings },
        ...(isAdmin ? [{ href: "/admin", label: "Administración", icon: ShieldCheck }] : []),
      ]
    : [];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir el menú"
        aria-expanded={open}
        className="relative inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] text-ink-700 hover:bg-ink-100 lg:hidden"
      >
        <Menu size={21} aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-2 right-2 h-2 w-2 rounded-full bg-danger-600"
          />
        )}
      </button>

      <Overlay open={open} onClose={() => setOpen(false)} title="Menú" variant="sheet">
        <nav aria-label="Menú principal" className="space-y-6">
          <ul className="space-y-0.5">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="flex min-h-11 items-center rounded-[var(--radius-control)] px-3 text-body font-medium text-ink-950 hover:bg-ink-100"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>

          {personal.length > 0 && (
            <ul className="space-y-0.5 border-t border-line pt-4">
              {personal.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-small text-ink-700 hover:bg-ink-100"
                  >
                    <item.icon size={17} className="shrink-0 text-ink-500" aria-hidden="true" />
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <ul className="space-y-0.5 border-t border-line pt-4">
            <li>
              <Link
                href="/ayuda"
                className="flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-small text-ink-700 hover:bg-ink-100"
              >
                <LifeBuoy size={17} className="shrink-0 text-ink-500" aria-hidden="true" />
                Ayuda y contacto
              </Link>
            </li>
            {!signedIn && (
              <li>
                <Link
                  href="/entrar"
                  className="flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-small text-ink-700 hover:bg-ink-100"
                >
                  <User size={17} className="shrink-0 text-ink-500" aria-hidden="true" />
                  Iniciar sesión
                </Link>
              </li>
            )}
          </ul>
        </nav>

        <div className="mt-6 space-y-2">
          <ButtonLink href="/publicar" size="lg" fullWidth>
            Publicar un trabajo
          </ButtonLink>
          {signedIn ? (
            <form action={signOutAction}>
              <button
                type="submit"
                className="flex min-h-11 w-full items-center justify-center rounded-[var(--radius-control)] text-small font-medium text-ink-600 hover:bg-ink-100"
              >
                Cerrar sesión
              </button>
            </form>
          ) : (
            <ButtonLink href="/crear-cuenta" variant="outline" size="lg" fullWidth>
              Crear una cuenta
            </ButtonLink>
          )}
        </div>
      </Overlay>
    </>
  );
}
