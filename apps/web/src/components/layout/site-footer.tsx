import Link from "next/link";

import { Mail, MapPin } from "lucide-react";

import { site } from "@/config/site";

import { Logo } from "./logo";

/**
 * Pie.
 *
 * Aquí vive todo lo que no cabe en una cabecera de cuatro enlaces: las páginas
 * legales, las de confianza y el contacto. En móvil baja del todo y queda por
 * encima de la barra inferior gracias al relleno del layout.
 *
 * No hay redes sociales inventadas ni un teléfono de atención que no existe:
 * un enlace muerto en el pie es una promesa rota.
 */
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
    title: "Ayuda",
    links: [
      { href: "/ayuda", label: "Centro de ayuda" },
      { href: "/contacto", label: "Contacto" },
      { href: "/terminos", label: "Términos y condiciones" },
      { href: "/privacidad", label: "Política de privacidad" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="container-page py-12 sm:py-16">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-small text-ink-600">{site.description}</p>
            <ul className="mt-5 space-y-2 text-small text-ink-600">
              <li className="flex items-center gap-2">
                <MapPin size={15} className="shrink-0 text-ink-400" aria-hidden="true" />
                Todo Chile
              </li>
              <li className="flex items-center gap-2">
                <Mail size={15} className="shrink-0 text-ink-400" aria-hidden="true" />
                <a
                  href={`mailto:${site.contactEmail}`}
                  className="hover:text-brand-700 hover:underline"
                >
                  {site.contactEmail}
                </a>
              </li>
            </ul>
          </div>

          {columns.map((column) => (
            <div key={column.title}>
              <h3 className="text-small font-semibold text-ink-950">{column.title}</h3>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-small text-ink-600 transition-colors hover:text-brand-700"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-line pt-6 text-caption text-ink-500 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {site.name}. Todos los derechos reservados.
          </p>
          <p>
            {site.name} conecta a personas; no realiza trámites en nombre de nadie ni reemplaza
            a quien debe presentarse en persona.
          </p>
        </div>
      </div>
    </footer>
  );
}
