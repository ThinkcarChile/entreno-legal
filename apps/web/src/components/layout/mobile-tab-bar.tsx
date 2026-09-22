"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  ClipboardList,
  Home,
  MessageCircle,
  Plus,
  Search,
  User,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils/cn";

export type NavMode = "client" | "worker";

interface Tab {
  href: string;
  label: string;
  icon: LucideIcon;
}

const clientTabs: readonly Tab[] = [
  { href: "/", label: "Inicio", icon: Home },
  { href: "/trabajos", label: "Explorar", icon: Search },
  { href: "/mensajes", label: "Mensajes", icon: MessageCircle },
  { href: "/cuenta", label: "Perfil", icon: User },
];

const workerTabs: readonly Tab[] = [
  { href: "/", label: "Inicio", icon: Home },
  { href: "/trabajos", label: "Explorar", icon: Search },
  { href: "/mis-trabajos", label: "Mis trabajos", icon: ClipboardList },
  { href: "/cuenta", label: "Perfil", icon: User },
];

/**
 * Barra inferior de navegación en móvil.
 *
 * Cuatro destinos y el botón de publicar en el centro, elevado. Antes eran
 * cinco destinos con una marca `emphasis` que no producía ningún estilo: el
 * botón central estaba declarado como destacado y se veía igual que los demás.
 * Ahora el destaque existe de verdad, y por eso sale de la rejilla.
 *
 * Solo bajo `lg`. El layout reserva su alto con `.pb-tabbar` en la columna
 * entera —no solo en el `main`, o el pie queda debajo de la barra—, y
 * respeta el área segura del teléfono.
 */
export function MobileTabBar({ mode = "client" }: { mode?: NavMode }) {
  const pathname = usePathname();
  const tabs = mode === "worker" ? workerTabs : clientTabs;

  function isActive(href: string): boolean {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  return (
    <nav
      aria-label="Navegación principal"
      className="fixed inset-x-0 bottom-0 z-(--z-index-header) border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
    >
      <ul className="relative mx-auto grid max-w-md grid-cols-5 items-end">
        {tabs.slice(0, 2).map((tab) => (
          <TabLink key={tab.href} tab={tab} active={isActive(tab.href)} />
        ))}

        <li className="flex justify-center">
          <Link
            href="/publicar"
            aria-label="Publicar un trabajo"
            aria-current={pathname.startsWith("/publicar") ? "page" : undefined}
            className="-mt-5 inline-flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-[var(--shadow-raised)] transition-colors hover:bg-brand-700 active:bg-brand-800"
          >
            <Plus size={24} strokeWidth={2.4} aria-hidden="true" />
          </Link>
        </li>

        {tabs.slice(2).map((tab) => (
          <TabLink key={tab.href} tab={tab} active={isActive(tab.href)} />
        ))}
      </ul>
    </nav>
  );
}

function TabLink({ tab, active }: { tab: Tab; active: boolean }) {
  const Icon = tab.icon;
  return (
    <li>
      <Link
        href={tab.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-(--spacing-tabbar) flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition-colors",
          active ? "text-brand-700" : "text-ink-500 hover:text-ink-800",
        )}
      >
        <Icon size={22} strokeWidth={active ? 2.3 : 1.8} aria-hidden="true" />
        {tab.label}
      </Link>
    </li>
  );
}
