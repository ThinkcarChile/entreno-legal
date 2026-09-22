import Link from "next/link";

import { Logo } from "@/components/layout/logo";

// Solo se enlaza lo que existe: un enlace a una pantalla que no está es un 404
// con el logotipo puesto.
const sections = [
  { href: "/admin", label: "Resumen" },
  { href: "/admin/verificaciones", label: "Verificaciones" },
  { href: "/admin/check-ins", label: "Llegadas" },
  { href: "/admin/disputas", label: "Disputas" },
  { href: "/admin/payouts", label: "Pagos" },
];

/**
 * Panel interno.
 *
 * El acceso real se controla en el middleware y, sobre todo, en las políticas RLS:
 * ocultar un enlace no es una medida de seguridad.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="container-page flex h-16 items-center justify-between gap-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo compact />
            <span className="text-small font-semibold text-ink-950">Administración</span>
          </Link>
          <nav aria-label="Secciones" className="hidden gap-1 md:flex">
            {sections.map((section) => (
              <Link
                key={section.href}
                href={section.href}
                className="rounded-[var(--radius-control)] px-3 py-2 text-small font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-950"
              >
                {section.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

/**
 * Estas páginas dependen de quién esté conectado, así que nunca se prerenderizan:
 * una versión cacheada mostraría la sesión equivocada.
 */
export const dynamic = "force-dynamic";
