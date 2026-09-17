import type { MetadataRoute } from "next";

import { site } from "@/config/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Áreas privadas o sin valor para búsqueda.
        disallow: ["/admin", "/cuenta", "/mensajes", "/mis-trabajos", "/entrar", "/crear-cuenta", "/auth/"],
      },
    ],
    sitemap: `${site.url}/sitemap.xml`,
    host: site.url,
  };
}
