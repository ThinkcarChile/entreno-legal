import Link from "next/link";

export type NavKey =
  | "home"
  | "family"
  | "catalog"
  | "recipes"
  | "plan"
  | "shopping"
  | "pantry"
  | "procurement"
  | "prep"
  | "health";

/**
 * Navegación del kit NutriFamilia: en móvil una barra superior + bottom nav
 * de cinco destinos; en escritorio una barra lateral fija con todo.
 *
 * El bottom nav lleva SOLO lo que se usa parado en la cocina o en el súper.
 * Lo demás vive en el lateral y en los accesos de cada pantalla: cinco
 * destinos caben cómodos con el pulgar en 320 px, nueve no.
 */
const DESTINOS: { key: NavKey; href: string; icon: string; label: string; enBottom: boolean }[] = [
  { key: "home", href: "/", icon: "home", label: "Inicio", enBottom: true },
  { key: "plan", href: "/plan", icon: "calendar_month", label: "Semana", enBottom: true },
  { key: "prep", href: "/prep", icon: "restaurant", label: "Cocina", enBottom: true },
  { key: "shopping", href: "/shopping", icon: "shopping_cart", label: "Compras", enBottom: true },
  { key: "health", href: "/health", icon: "favorite", label: "Salud", enBottom: true },
  { key: "pantry", href: "/pantry", icon: "inventory_2", label: "Despensa", enBottom: false },
  { key: "procurement", href: "/procurement", icon: "local_shipping", label: "Pedidos", enBottom: false },
  { key: "recipes", href: "/recipes", icon: "menu_book", label: "Recetas", enBottom: false },
  { key: "catalog", href: "/catalog", icon: "nutrition", label: "Catálogo", enBottom: false },
  { key: "family", href: "/family", icon: "group", label: "Familia", enBottom: false },
];

function Icono({ name, activo }: { name: string; activo?: boolean }) {
  return (
    <span className={`material-symbols-outlined${activo ? " filled" : ""}`} aria-hidden>
      {name}
    </span>
  );
}

/**
 * Envuelve una pantalla completa. `title`/`subtitle` arman el encabezado
 * grande del kit; `action` es el botón principal a la derecha.
 */
export function AppShell({
  active,
  title,
  subtitle,
  action,
  children,
  wide = false,
}: {
  active: NavKey;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  /** `true` deja el contenido usar todo el ancho del escritorio (tableros). */
  wide?: boolean;
}) {
  return (
    <div className="relative flex min-h-dvh flex-col md:flex-row">
      {/* Barra superior — solo móvil */}
      <header className="sticky top-0 z-40 flex w-full items-center justify-between bg-background px-container-margin py-sm md:hidden">
        <Link href="/" className="flex items-center gap-sm">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-fixed text-on-primary-fixed">
            <Icono name="family_restroom" />
          </span>
          <h1 className="font-headline-md text-headline-md font-bold tracking-tight text-primary">
            NutriFamilia
          </h1>
        </Link>
        <Link
          href="/health"
          aria-label="Salud"
          className="flex h-10 w-10 items-center justify-center rounded-full text-primary transition-colors hover:bg-surface-variant/50"
        >
          <Icono name="notifications" />
        </Link>
      </header>

      {/* Barra lateral — solo escritorio */}
      <nav className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-outline-variant/30 bg-background py-lg md:flex">
        <Link href="/" className="mb-xl flex items-center gap-sm px-lg">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-fixed text-on-primary-fixed">
            <Icono name="family_restroom" />
          </span>
          <h1 className="font-headline-md text-headline-md font-bold tracking-tight text-primary">
            NutriFamilia
          </h1>
        </Link>
        <div className="flex flex-col gap-xs overflow-y-auto px-md">
          {DESTINOS.map((d) => {
            const on = d.key === active;
            return (
              <Link
                key={d.key}
                href={d.href}
                aria-current={on ? "page" : undefined}
                className={`flex items-center gap-md rounded-lg px-md py-sm transition-colors ${
                  on
                    ? "bg-primary-container/20 font-bold text-primary"
                    : "text-on-surface-variant hover:bg-surface-container-high"
                }`}
              >
                <Icono name={d.icon} activo={on} />
                <span className="font-body-md text-body-md">{d.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Lienzo */}
      <main className="flex-1 pb-28 md:pb-0">
        <div className="sticky top-[56px] z-30 bg-background/95 px-container-margin pt-lg pb-md backdrop-blur-sm md:top-0 md:px-xl md:pt-xl">
          <div className="flex items-start justify-between gap-md">
            <div className="min-w-0">
              <h2 className="font-headline-lg-mobile text-headline-lg-mobile text-on-surface md:font-headline-lg md:text-headline-lg">
                {title}
              </h2>
              {subtitle && (
                <p className="mt-1 font-body-md text-body-md text-on-surface-variant">{subtitle}</p>
              )}
            </div>
            {action && <div className="shrink-0">{action}</div>}
          </div>
        </div>
        <div
          className={`px-container-margin pb-xxl md:px-xl ${wide ? "" : "mx-auto max-w-4xl"}`}
        >
          {children}
        </div>
      </main>

      {/* Bottom nav — solo móvil */}
      <nav className="fixed bottom-0 left-0 z-50 flex w-full justify-around rounded-t-xl bg-background/90 px-2 pt-2 pb-6 shadow-[0_-4px_20px_rgba(114,161,131,0.08)] backdrop-blur-md md:hidden">
        {DESTINOS.filter((d) => d.enBottom).map((d) => {
          const on = d.key === active;
          return (
            <Link
              key={d.key}
              href={d.href}
              aria-current={on ? "page" : undefined}
              className={`group flex flex-col items-center justify-center ${
                on
                  ? "text-primary after:mt-1 after:h-1 after:w-1 after:rounded-full after:bg-primary after:content-['']"
                  : "text-on-surface-variant"
              }`}
            >
              <span
                className={`material-symbols-outlined transition-transform duration-200 group-active:scale-95${on ? " filled" : ""}`}
                aria-hidden
              >
                {d.icon}
              </span>
              <span className="mt-1 font-label-md text-label-md">{d.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Botón principal del encabezado (relleno, píldora). */
export function ShellAction({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-sm rounded-full bg-primary px-lg py-sm font-body-md text-body-sm font-semibold text-on-primary transition-transform active:scale-95"
    >
      {children}
    </Link>
  );
}
