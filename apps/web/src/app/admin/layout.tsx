import Link from "next/link";

import { AdminNav } from "@/components/admin/admin-nav";
import { Logo } from "@/components/layout/logo";

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
          <Link href="/" className="flex items-center gap-3" aria-label="HagoTuFila, ir al inicio">
            <Logo />
          </Link>
          <span className="text-label text-brand-700 uppercase">Administración</span>
        </div>
      </header>
      <div className="container-page grid flex-1 gap-5 py-5 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-6 lg:py-6">
        <aside className="min-w-0 lg:self-start">
          <AdminNav />
        </aside>
        {/* Las páginas traen su propio `container-page`; aquí ya no hace falta su margen. */}
        <main className="min-w-0 [&>.container-page]:px-0 [&>.container-page]:pt-2 lg:[&>.container-page]:pt-0">
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Estas páginas dependen de quién esté conectado, así que nunca se prerenderizan:
 * una versión cacheada mostraría la sesión equivocada.
 */
export const dynamic = "force-dynamic";
