import { DemoBanner } from "@/components/layout/demo-banner";
import { ModeIndicator } from "@/components/layout/mode-indicator";
import { MobileTabBar } from "@/components/layout/mobile-tab-bar";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { getViewer } from "@/lib/auth/session";
import { UserRole } from "@/lib/domain/enums";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getViewer();
  // La misma cuenta puede operar en los dos modos. La barra inferior muestra el
  // del trabajador solo cuando ese modo está activo.
  const mode = session?.modes.includes(UserRole.WORKER) ? "worker" : "client";

  return (
    <div className="flex min-h-dvh flex-col pb-tabbar lg:pb-0">
      <ModeIndicator />
      <DemoBanner />
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
      <MobileTabBar mode={mode} />
    </div>
  );
}

/**
 * Estas páginas dependen de quién esté conectado, así que nunca se prerenderizan:
 * una versión cacheada mostraría la sesión equivocada.
 */
export const dynamic = "force-dynamic";
