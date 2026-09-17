import type { Metadata } from "next";

import { Categories } from "@/components/home/categories";
import { FinalCta } from "@/components/home/cta";
import { Faq, faqs } from "@/components/home/faq";
import { FeaturedWorkers } from "@/components/home/featured-workers";
import { Hero } from "@/components/home/hero";
import { HowItWorks } from "@/components/home/how-it-works";
import { ProtectedPayment } from "@/components/home/protected-payment";
import { Testimonials } from "@/components/home/testimonials";
import { site } from "@/config/site";
import { getData } from "@/lib/data";
import { demoFeaturedReviews } from "@/lib/data/demo";

export const metadata: Metadata = {
  title: `${site.name} — ${site.claim}`,
  description: site.description,
  alternates: { canonical: "/" },
};

export default async function HomePage() {
  const data = getData();

  const [categories, counts, workers] = await Promise.all([
    data.categories.list(),
    data.jobs.countByCategory(),
    data.workers.listFeatured(4),
  ]);

  // Las reseñas destacadas de portada aún no tienen origen en base de datos.
  const reviews = demoFeaturedReviews(3);

  return (
    <>
      <StructuredData />
      <Hero />
      <HowItWorks />
      <ProtectedPayment />
      <Categories categories={categories} counts={counts} />
      <FeaturedWorkers workers={workers} />
      <Testimonials reviews={reviews} />
      <Faq />
      <FinalCta />
    </>
  );
}

/** Datos estructurados para búsqueda. Se mantienen junto a la página que describen. */
function StructuredData() {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${site.url}/#organization`,
        name: site.name,
        url: site.url,
        areaServed: { "@type": "Country", name: "Chile" },
        description: site.description,
      },
      {
        "@type": "WebSite",
        "@id": `${site.url}/#website`,
        url: site.url,
        name: site.name,
        inLanguage: "es-CL",
        publisher: { "@id": `${site.url}/#organization` },
      },
      {
        "@type": "FAQPage",
        mainEntity: faqs.map((faq) => ({
          "@type": "Question",
          name: faq.question,
          acceptedAnswer: { "@type": "Answer", text: faq.answer },
        })),
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }}
    />
  );
}
