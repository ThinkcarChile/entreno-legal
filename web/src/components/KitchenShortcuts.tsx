import Link from "next/link";
import { Icon } from "@/components/ui";

/**
 * §57: "¿Qué quieres hacer?" — el atajo que conecta cocina con inventario sin
 * saturar el dashboard. Botones grandes, pensado para el celular en la cocina.
 */
export function KitchenShortcuts() {
  const items = [
    { href: "/plan", icon: "cooking", label: "Cocinar ahora" },
    { href: "/prep", icon: "shopping_basket", label: "Preparar compra" },
    { href: "/prep", icon: "pie_chart", label: "Porcionar" },
    { href: "/plan", icon: "room_service", label: "Servir" },
    { href: "/pantry", icon: "takeout_dining", label: "Usar sobras" },
    { href: "/pantry", icon: "schedule", label: "Qué usar pronto" },
  ];
  return (
    <section className="mt-md">
      <p className="mb-sm font-body-sm text-body-sm font-semibold text-on-surface">
        ¿Qué quieres hacer?
      </p>
      <div className="grid grid-cols-3 gap-sm">
        {items.map((i) => (
          <Link
            key={i.label}
            href={i.href}
            className="flex min-h-[88px] flex-col items-center justify-center gap-1 rounded-2xl bg-surface-container px-2 py-md text-center text-on-surface transition-transform hover:bg-surface-container-high active:scale-95"
          >
            <Icon name={i.icon} className="text-[28px] text-primary" />
            <span className="font-label-md text-label-md leading-tight">{i.label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
