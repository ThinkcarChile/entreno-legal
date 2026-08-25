import Link from "next/link";

/**
 * §57: "¿Qué quieres hacer?" — el atajo que conecta cocina con inventario sin
 * saturar el dashboard. Botones grandes, pensado para el celular en la cocina.
 */
export function KitchenShortcuts() {
  const items = [
    { href: "/plan", icon: "🍳", label: "Cocinar ahora" },
    { href: "/prep", icon: "🔪", label: "Preparar compra" },
    { href: "/prep", icon: "📦", label: "Porcionar" },
    { href: "/plan", icon: "🍽", label: "Servir" },
    { href: "/pantry", icon: "🥡", label: "Usar sobras" },
    { href: "/pantry", icon: "⏳", label: "Qué usar pronto" },
  ];
  return (
    <section className="mt-4">
      <p className="mb-2 text-sm font-semibold">¿Qué quieres hacer?</p>
      <div className="grid grid-cols-3 gap-2">
        {items.map((i) => (
          <Link
            key={i.label}
            href={i.href}
            className="flex flex-col items-center gap-1 rounded-2xl border border-[var(--ink)]/10 bg-white px-2 py-3 text-center"
          >
            <span className="text-2xl">{i.icon}</span>
            <span className="text-[11px] font-medium leading-tight">{i.label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
