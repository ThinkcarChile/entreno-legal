import type { MetadataRoute } from "next";

import { site } from "@/config/site";
import { brand } from "@/config/brand";

/**
 * Manifiesto web.
 *
 * Con esto la aplicación es instalable de verdad: nombre, iconos —incluido uno
 * `maskable`, que es el que Android recorta sin comerse el símbolo—, color de
 * tema y pantalla completa.
 *
 * `orientation` queda en `any` a propósito: el trabajo se usa de pie en una
 * fila, con el teléfono en cualquier posición, y forzar vertical es una
 * molestia sin motivo.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${site.name} — ${site.claim}`,
    short_name: site.shortName,
    description: site.description,
    id: "/",
    start_url: "/?fuente=pwa",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: brand.canvas,
    theme_color: brand.primary,
    lang: "es-CL",
    dir: "ltr",
    categories: ["business", "productivity", "lifestyle"],
    icons: [
      { src: "/icons/icon-192.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-512.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any" },
      {
        src: "/icons/icon-maskable.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      { name: "Publicar un trabajo", short_name: "Publicar", url: "/publicar" },
      { name: "Explorar trabajos", short_name: "Explorar", url: "/trabajos" },
      { name: "Mis trabajos", short_name: "Mis trabajos", url: "/mis-trabajos" },
    ],
  };
}
