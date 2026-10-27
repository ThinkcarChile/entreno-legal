"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils/cn";

// Solo se enlaza lo que existe: un enlace a una pantalla que no está es un 404
// con el logotipo puesto.
const sections = [
  { href: "/admin", label: "Resumen" },
  { href: "/admin/verificaciones", label: "Verificaciones" },
  { href: "/admin/check-ins", label: "Llegadas" },
  { href: "/admin/disputas", label: "Disputas" },
  { href: "/admin/pagos", label: "Pagos de clientes" },
  { href: "/admin/payouts", label: "Pagos a trabajadores" },
];

/**
 * Menú de la administración.
 *
 * Lateral y oscuro en escritorio, una fila desplazable en móvil. La sección
 * activa se marca con `aria-current` además del color: el lima sobre verde
 * oscuro se distingue, pero no todo el mundo distingue colores.
 */
export function AdminNav() {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    return href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
  }

  return (
    <nav
      aria-label="Secciones de administración"
      className="rounded-[var(--radius-card)] bg-brand-950 p-2 lg:sticky lg:top-6 lg:p-3"
    >
      <ul className="scroll-row gap-1 lg:flex-col lg:overflow-visible">
        {sections.map((section) => {
          const active = isActive(section.href);
          return (
            <li key={section.href} className="shrink-0">
              <Link
                href={section.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center rounded-[var(--radius-chip)] px-3.5 text-small font-bold whitespace-nowrap transition-colors",
                  active
                    ? "bg-brand-800 text-accent-300"
                    : "text-brand-100 hover:bg-brand-900 hover:text-white",
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
