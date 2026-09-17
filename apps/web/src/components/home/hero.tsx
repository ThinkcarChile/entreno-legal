import { BadgeCheck, MapPin, ShieldCheck } from "lucide-react";

import { ButtonLink } from "@/components/ui";
import { site } from "@/config/site";

export function Hero() {
  return (
    <section className="border-b border-ink-200/60 bg-white">
      <div className="container-page grid gap-12 py-16 sm:py-24 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-16">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 ring-1 ring-brand-100 ring-inset">
            <MapPin size={14} aria-hidden="true" />
            Disponible en todo Chile
          </p>

          <h1 className="mt-6 text-[2.25rem] leading-[1.1] font-semibold tracking-tight text-ink-900 sm:text-5xl lg:text-[3.25rem]">
            {site.claim}
          </h1>

          <p className="mt-5 max-w-xl text-lg text-ink-600">{site.description}</p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <ButtonLink href="/publicar" size="lg" className="sm:w-auto">
              Necesito ayuda
            </ButtonLink>
            <ButtonLink href="/trabajar" variant="outline" size="lg" className="sm:w-auto">
              Quiero ganar dinero
            </ButtonLink>
          </div>

          <dl className="mt-10 grid max-w-lg grid-cols-3 gap-6 border-t border-ink-100 pt-8">
            <div>
              <dt className="text-sm text-ink-500">Trabajadores verificados</dt>
              <dd className="mt-1 text-2xl font-semibold text-ink-900 tabular-nums">238</dd>
            </div>
            <div>
              <dt className="text-sm text-ink-500">Trabajos completados</dt>
              <dd className="mt-1 text-2xl font-semibold text-ink-900 tabular-nums">1.047</dd>
            </div>
            <div>
              <dt className="text-sm text-ink-500">Calificación media</dt>
              <dd className="mt-1 text-2xl font-semibold text-ink-900 tabular-nums">4,9</dd>
            </div>
          </dl>
        </div>

        <HeroCard />
      </div>
    </section>
  );
}

/**
 * Tarjeta ilustrativa del producto real, no una fotografía decorativa:
 * muestra lo que el cliente verá al recibir ofertas.
 */
function HeroCard() {
  return (
    <div className="relative">
      <div className="rounded-[var(--radius-card)] border border-ink-200/70 bg-white p-6 shadow-[var(--shadow-raised)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium tracking-wide text-ink-500 uppercase">
              Trabajo publicado
            </p>
            <p className="mt-1.5 font-semibold text-ink-900">
              Fila para entradas en Costanera Center
            </p>
            <p className="mt-1 text-sm text-ink-500">Sábado · 05:00 a 10:00 · Providencia</p>
          </div>
          <span className="shrink-0 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700">
            5 h
          </span>
        </div>

        <p className="mt-5 text-xs font-medium tracking-wide text-ink-500 uppercase">
          Ofertas recibidas
        </p>

        <ul className="mt-3 space-y-2.5">
          {[
            { name: "Camila F.", rate: "$8.500/h", jobs: "134 trabajos", level: "Experto" },
            { name: "Tomás R.", rate: "$12.500/h", jobs: "71 trabajos", level: "Experto" },
            { name: "Daniela P.", rate: "$10.000/h", jobs: "25 trabajos", level: "Pro" },
          ].map((offer) => (
            <li
              key={offer.name}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-ink-100 px-3.5 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
                  {offer.name.charAt(0)}
                </span>
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-ink-900">
                    <span className="truncate">{offer.name}</span>
                    <BadgeCheck size={14} className="shrink-0 text-brand-600" aria-hidden="true" />
                  </p>
                  <p className="truncate text-xs text-ink-500">
                    {offer.jobs} · {offer.level}
                  </p>
                </div>
              </div>
              <span className="shrink-0 text-sm font-semibold text-ink-900 tabular-nums">
                {offer.rate}
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-5 flex items-center gap-2 rounded-[var(--radius-control)] bg-success-50 px-3.5 py-3 text-sm text-success-700">
          <ShieldCheck size={16} aria-hidden="true" className="shrink-0" />
          El pago queda protegido hasta que el servicio se complete.
        </p>
      </div>
    </div>
  );
}
