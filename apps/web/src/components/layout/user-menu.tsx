"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ChevronDown, LogOut, Settings, UserRound } from "lucide-react";

import { Avatar } from "@/components/ui";
import { signOutAction } from "@/lib/actions/auth";

export interface UserMenuProps {
  displayName: string;
  avatarUrl: string | null;
  isWorker: boolean;
  isAdmin: boolean;
}

export function UserMenu({ displayName, avatarUrl, isWorker, isAdmin }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Cerrar al hacer clic fuera es lo que la gente espera de un menú así.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-full py-1 pr-2 pl-1 transition-colors hover:bg-ink-100"
      >
        <Avatar src={avatarUrl} name={displayName} size="sm" />
        <span className="hidden max-w-32 truncate text-sm font-medium text-ink-800 sm:block">
          {displayName}
        </span>
        <ChevronDown size={15} className="text-ink-400" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-[var(--radius-card)] border border-ink-200 bg-white shadow-[var(--shadow-raised)]"
        >
          <div className="p-1.5">
            <MenuLink href="/cuenta" icon={<UserRound size={15} />} onSelect={() => setOpen(false)}>
              Mi cuenta
            </MenuLink>
            <MenuLink
              href="/mis-trabajos/publicados"
              onSelect={() => setOpen(false)}
            >
              Trabajos que publiqué
            </MenuLink>
            {isWorker && (
              <>
                <MenuLink href="/mis-trabajos" onSelect={() => setOpen(false)}>
                  Mis trabajos como trabajador
                </MenuLink>
                <MenuLink
                  href="/cuenta/trabajador"
                  icon={<Settings size={15} />}
                  onSelect={() => setOpen(false)}
                >
                  Perfil de trabajador
                </MenuLink>
              </>
            )}
            {isAdmin && (
              <MenuLink href="/admin" onSelect={() => setOpen(false)}>
                Administración
              </MenuLink>
            )}
          </div>

          <form action={signOutAction} className="border-t border-ink-100 p-1.5">
            <button
              type="submit"
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"
            >
              <LogOut size={15} aria-hidden="true" />
              Cerrar sesión
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  icon,
  children,
  onSelect,
}: {
  href: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onSelect}
      className="flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 text-sm text-ink-700 hover:bg-ink-50"
    >
      {icon ?? <span className="w-[15px]" aria-hidden="true" />}
      {children}
    </Link>
  );
}
