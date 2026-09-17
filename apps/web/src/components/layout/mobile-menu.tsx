"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Menu, X } from "lucide-react";

import { ButtonLink } from "@/components/ui";

export interface MobileMenuProps {
  items: readonly { href: string; label: string }[];
  signedIn?: boolean;
  unreadCount?: number;
}

export function MobileMenu({ items, signedIn = false, unreadCount = 0 }: MobileMenuProps) {
  const [open, setOpen] = useState(false);

  // Bloquea el scroll de fondo mientras el panel está abierto.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-ink-700 hover:bg-ink-100"
        aria-label="Abrir menú"
        aria-expanded={open}
      >
        <Menu size={20} aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute mt-[-1.1rem] ml-5 inline-flex h-2 w-2 rounded-full bg-danger-600" />
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 bg-white">
          <div className="container-page flex h-16 items-center justify-end">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-ink-700 hover:bg-ink-100"
              aria-label="Cerrar menú"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          <nav className="container-page mt-4 flex flex-col gap-1" aria-label="Principal móvil">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="rounded-[var(--radius-control)] px-3 py-3.5 text-lg font-medium text-ink-800 hover:bg-ink-50"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          {signedIn && (
            <nav className="container-page mt-4 flex flex-col gap-1 border-t border-ink-100 pt-4">
              {[
                { href: "/mis-trabajos/publicados", label: "Trabajos que publiqué" },
                { href: "/mis-trabajos", label: "Mis trabajos" },
                { href: "/mensajes", label: "Mensajes" },
                { href: "/notificaciones", label: `Notificaciones${unreadCount > 0 ? ` (${unreadCount})` : ""}` },
                { href: "/cuenta", label: "Mi cuenta" },
              ].map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="rounded-[var(--radius-control)] px-3 py-3 text-base font-medium text-ink-700 hover:bg-ink-50"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          )}

          <div className="container-page mt-8 flex flex-col gap-3">
            <ButtonLink href="/publicar" size="lg" fullWidth onClick={() => setOpen(false)}>
              Publicar un trabajo
            </ButtonLink>
            {!signedIn && (
              <ButtonLink
                href="/entrar"
                variant="outline"
                size="lg"
                fullWidth
                onClick={() => setOpen(false)}
              >
                Entrar
              </ButtonLink>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
