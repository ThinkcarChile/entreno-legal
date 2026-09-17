import Link from "next/link";

import { site } from "@/config/site";

import { Logo } from "./logo";

const columns = [
  {
    title: "Producto",
    links: [
      { href: "/trabajos", label: "Buscar trabajos" },
      { href: "/publicar", label: "Publicar un trabajo" },
      { href: "/trabajadores", label: "Trabajadores verificados" },
      { href: "/precios", label: "Precios sugeridos" },
    ],
  },
  {
    title: "Confianza",
    links: [
      { href: "/como-funciona", label: "Cómo funciona" },
      { href: "/pago-protegido", label: site.protectedPaymentLabel },
      { href: "/verificacion", label: "Verificación de identidad" },
      { href: "/reglas", label: "Reglas de uso" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/terminos", label: "Términos y condiciones" },
      { href: "/privacidad", label: "Política de privacidad" },
      { href: "/contacto", label: "Contacto" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-ink-200/70 bg-white">
      <div className="container-page py-12 sm:py-16">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm text-ink-600">
              {site.description}
            </p>
          </div>

          {columns.map((column) => (
            <div key={column.title}>
              <h3 className="text-sm font-semibold text-ink-900">{column.title}</h3>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-ink-600 transition-colors hover:text-brand-700"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-ink-100 pt-6 text-sm text-ink-500 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {site.name}. Todos los derechos reservados.
          </p>
          <p>Hecho en Chile, disponible en todo el país.</p>
        </div>
      </div>
    </footer>
  );
}
