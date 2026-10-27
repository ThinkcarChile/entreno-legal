import type { MetadataRoute } from "next";

import { site } from "@/config/site";
import { currentDeploymentStage } from "@/lib/env";

export default function robots(): MetadataRoute.Robots {
  // Una versión de prueba no se indexa: nadie debería llegar a ella desde un
  // buscador antes del lanzamiento.
  if (currentDeploymentStage === "trial") {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }

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
