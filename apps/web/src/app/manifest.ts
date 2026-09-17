import type { MetadataRoute } from "next";

import { site } from "@/config/site";

/**
 * Manifiesto web.
 *
 * Deja el proyecto listo para convertirse en PWA: falta únicamente registrar un
 * service worker y agregar los iconos definitivos.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${site.name} — ${site.claim}`,
    short_name: site.shortName,
    description: site.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f8fb",
    theme_color: "#3049dc",
    lang: "es-CL",
    categories: ["business", "productivity", "lifestyle"],
  };
}
