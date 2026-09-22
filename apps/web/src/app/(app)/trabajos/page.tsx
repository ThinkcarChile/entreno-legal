import type { Metadata } from "next";

import { SearchX } from "lucide-react";

import { JobCard } from "@/components/jobs/job-card";
import { JobFilters } from "@/components/jobs/job-filters";
import { ButtonLink, EmptyState } from "@/components/ui";
import { CategoryGroup, JobUrgency } from "@/lib/domain/enums";
import { getData, type JobFilters as Filters, type JobSort } from "@/lib/data";

export const metadata: Metadata = {
  title: "Trabajos disponibles",
  description:
    "Filas, trámites y gestiones publicados en todo Chile. Filtra por región, comuna y categoría, y envía tu oferta.",
  alternates: { canonical: "/trabajos" },
};

const PAGE_SIZE = 12;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value || undefined;
}

export default async function JobsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const data = getData();
  const categories = await data.categories.list();

  const categorySlug = single(params.categoria);
  const category = categorySlug ? categories.find((c) => c.slug === categorySlug) : undefined;
  const page = Math.max(1, Number(single(params.pagina) ?? 1) || 1);

  const filters: Filters = {
    query: single(params.q),
    categoryGroup: single(params.tipo) as CategoryGroup | undefined,
    categoryIds: category ? [category.id] : undefined,
    regionCode: single(params.region),
    communeCode: single(params.comuna),
    urgency: single(params.urgencia) as JobUrgency | undefined,
    overnightOnly: single(params.overnight) === "1",
    withBonusOnly: single(params.bono) === "1",
    minHourlyRate: Number(single(params.pagoMin) ?? 0) || undefined,
    maxDurationMinutes: Number(single(params.duracionMax) ?? 0) || undefined,
    fromDate: single(params.desde),
    toDate: single(params.hasta),
    sort: (single(params.orden) as JobSort | undefined) ?? "recent",
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };

  const result = await data.jobs.listOpen(filters);
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

  return (
    <div className="container-page py-8 sm:py-12">
      <header className="max-w-2xl">
        <h1 className="text-h2 text-ink-950 sm:text-h1">
          Trabajos disponibles
        </h1>
        <p className="mt-2 text-ink-600">
          Encuentra filas, trámites y gestiones publicados en todo Chile. Envía tu oferta con la
          tarifa que tú decidas.
        </p>
      </header>

      <div className="mt-8">
        <JobFilters categories={categories} />
      </div>

      <p className="mt-6 text-small text-ink-500">
        {result.total === 0
          ? "Sin resultados"
          : `${result.total} ${result.total === 1 ? "trabajo" : "trabajos"} disponibles`}
      </p>

      {result.items.length === 0 ? (
        <EmptyState
          className="mt-4"
          icon={<SearchX size={28} aria-hidden="true" />}
          title="No encontramos trabajos con esos filtros"
          description="Prueba ampliar la región o quitar algún filtro. También puedes publicar tu propia necesidad."
          action={<ButtonLink href="/publicar">Publicar un trabajo</ButtonLink>}
        />
      ) : (
        <ul className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {result.items.map((job) => (
            <li key={job.id} className="relative flex">
              <JobCard job={job} />
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <nav className="mt-10 flex items-center justify-center gap-2" aria-label="Paginación">
          {Array.from({ length: totalPages }, (_, index) => index + 1).map((number) => {
            const next = new URLSearchParams(
              Object.entries(params).flatMap(([key, value]) =>
                value ? [[key, Array.isArray(value) ? value[0] : value] as [string, string]] : [],
              ),
            );
            next.set("pagina", String(number));

            return (
              <ButtonLink
                key={number}
                href={`/trabajos?${next.toString()}`}
                variant={number === page ? "primary" : "outline"}
                size="sm"
              >
                {number}
              </ButtonLink>
            );
          })}
        </nav>
      )}
    </div>
  );
}
