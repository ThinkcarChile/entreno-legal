import type { MetadataRoute } from "next";

import { site } from "@/config/site";
import { getData } from "@/lib/data";
import { regions } from "@/lib/geo/chile";

/**
 * Sitemap.
 *
 * Además de las páginas fijas incluye categorías y trabajos abiertos. Las rutas
 * regionales quedan preparadas para cuando existan páginas por región.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${site.url}/`, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${site.url}/trabajos`, lastModified: now, changeFrequency: "hourly", priority: 0.9 },
    { url: `${site.url}/publicar`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${site.url}/como-funciona`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${site.url}/precios`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${site.url}/trabajar`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${site.url}/trabajadores`, lastModified: now, changeFrequency: "daily", priority: 0.6 },
    { url: `${site.url}/pago-protegido`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${site.url}/verificacion`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${site.url}/reglas`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${site.url}/terminos`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${site.url}/privacidad`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${site.url}/contacto`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];

  const data = getData();
  const [categories, jobs] = await Promise.all([
    data.categories.list(),
    data.jobs.listOpen({ limit: 200 }),
  ]);

  const categoryRoutes: MetadataRoute.Sitemap = categories.map((category) => ({
    url: `${site.url}/trabajos?categoria=${category.slug}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: 0.6,
  }));

  const regionRoutes: MetadataRoute.Sitemap = regions.map((region) => ({
    url: `${site.url}/trabajos?region=${region.code}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: 0.5,
  }));

  const jobRoutes: MetadataRoute.Sitemap = jobs.items.map((job) => ({
    url: `${site.url}/trabajos/${job.id}`,
    lastModified: job.publishedAt ? new Date(job.publishedAt) : now,
    changeFrequency: "daily",
    priority: 0.6,
  }));

  return [...staticRoutes, ...categoryRoutes, ...regionRoutes, ...jobRoutes];
}
