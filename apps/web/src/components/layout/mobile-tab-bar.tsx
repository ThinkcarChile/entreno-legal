"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  Briefcase,
  ClipboardList,
  Home,
  MessageCircle,
  PlusCircle,
  Search,
  User,
} from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Navegación inferior móvil.
 *
 * La misma cuenta puede operar como cliente y como trabajador, así que las pestañas
 * dependen del modo activo, no de cuentas separadas.
 */
export type NavMode = "client" | "worker";

const clientTabs = [
  { href: "/", label: "Inicio", icon: Home },
  { href: "/trabajos", label: "Buscar", icon: Search },
  { href: "/publicar", label: "Publicar", icon: PlusCircle, emphasis: true },
  { href: "/mensajes", label: "Mensajes", icon: MessageCircle },
  { href: "/cuenta", label: "Perfil", icon: User },
] as const;

const workerTabs = [
  { href: "/", label: "Inicio", icon: Home },
  { href: "/trabajos", label: "Trabajos", icon: Search },
  { href: "/mis-trabajos", label: "Mis trabajos", icon: ClipboardList },
  { href: "/mensajes", label: "Mensajes", icon: MessageCircle },
  { href: "/cuenta", label: "Perfil", icon: User },
] as const;

export function MobileTabBar({ mode = "client" }: { mode?: NavMode }) {
  const pathname = usePathname();
  const tabs = mode === "worker" ? workerTabs : clientTabs;

  return (
    <nav
      aria-label="Navegación principal"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
    >
      <ul className="grid grid-cols-5">
        {tabs.map((tab) => {
          const Icon = "emphasis" in tab && tab.emphasis ? PlusCircle : tab.icon;
          const active =
            tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);

          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-[4.25rem] flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition-colors",
                  active ? "text-brand-600" : "text-ink-500",
                )}
              >
                <Icon size={22} aria-hidden="true" strokeWidth={active ? 2.2 : 1.8} />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export { Briefcase };
