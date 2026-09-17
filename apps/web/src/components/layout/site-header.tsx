import Link from "next/link";

import { ButtonLink } from "@/components/ui";
import { site } from "@/config/site";

import { Logo } from "./logo";
import { MobileMenu } from "./mobile-menu";

const navigation = [
  { href: "/trabajos", label: "Buscar trabajos" },
  { href: "/como-funciona", label: "Cómo funciona" },
  { href: "/trabajadores", label: "Trabajadores" },
  { href: "/precios", label: "Precios" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-ink-200/70 bg-white/85 backdrop-blur-md">
      <div className="container-page flex h-16 items-center justify-between gap-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label={site.name}>
          <Logo />
        </Link>

        <nav aria-label="Principal" className="hidden items-center gap-1 lg:flex">
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <ButtonLink href="/entrar" variant="ghost" size="sm">
            Entrar
          </ButtonLink>
          <ButtonLink href="/publicar" size="sm">
            Publicar un trabajo
          </ButtonLink>
        </div>

        <MobileMenu items={navigation} />
      </div>
    </header>
  );
}
