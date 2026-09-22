import Link from "next/link";

import { ArrowRight, Headphones, Lock, MapPin, ShieldCheck } from "lucide-react";

import { HomeSearch } from "@/components/home/home-search";
import { ButtonLink } from "@/components/ui";
import { site } from "@/config/site";

import type { JobCategory } from "@/lib/domain/types";

/**
 * Portada: lo primero y, para mucha gente, lo único que se lee.
 *
 * Dice qué es el servicio en una frase, deja buscar sin registrarse y nombra
 * las tres cosas que decide alguien que nunca ha delegado un trámite: quién va,
 * qué pasa con su dinero y a quién llama si algo sale mal.
 *
 * No hay cifras de uso. Con un producto que todavía no tiene volumen, un
 * «1.047 trabajos completados» sería inventado, y la confianza es exactamente
 * lo que se está vendiendo.
 */
export function Hero({ categories }: { categories: readonly JobCategory[] }) {
  return (
    <section className="relative overflow-hidden border-b border-line bg-surface">
      {/* Mancha cálida detrás del texto: da temperatura sin competir con él. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 -right-32 h-[32rem] w-[32rem] rounded-full bg-brand-50 blur-3xl"
      />

      <div className="container-page relative py-12 sm:py-16 lg:py-20">
        <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
          <div>
            <p className="inline-flex items-center gap-2 rounded-[var(--radius-pill)] bg-brand-50 px-3 py-1.5 text-small font-medium text-brand-700 ring-1 ring-brand-100 ring-inset">
              <MapPin size={14} aria-hidden="true" />
              Disponible en todo Chile
            </p>

            <h1 className="mt-5 text-[2.125rem] leading-[1.06] font-semibold tracking-tight text-ink-950 sm:text-[2.75rem] lg:text-[3.25rem]">
              Tu tiempo vale.
              <span className="block text-brand-600">Nosotros hacemos la fila.</span>
            </h1>

            <p className="mt-5 max-w-xl text-body text-ink-600 sm:text-[1.0625rem]">
              Encuentra personas verificadas para hacer filas y trámites por ti, en todo Chile.
            </p>

            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <ButtonLink href="/publicar" size="lg">
                Publicar un trabajo
                <ArrowRight size={17} aria-hidden="true" />
              </ButtonLink>
              <ButtonLink href="/trabajar" size="lg" variant="outline">
                Quiero trabajar
              </ButtonLink>
            </div>
          </div>

          <HeroPanel />
        </div>

        <div className="mt-10 lg:mt-12">
          <HomeSearch categories={categories} />
        </div>
      </div>

      <TrustStrip />
    </section>
  );
}

/**
 * Panel del producto.
 *
 * Muestra la forma de lo que se va a usar —un trabajo, unas ofertas, un pago
 * protegido— sin fingir datos de gente real: los nombres son iniciales y las
 * cifras son las del ejemplo, no las de nadie.
 */
function HeroPanel() {
  return (
    <div className="relative">
      <div className="rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-[var(--shadow-raised)] sm:p-6">
        <p className="text-label text-ink-500 uppercase">Así se ve un trabajo</p>

        <div className="mt-3 rounded-[var(--radius-control)] bg-canvas p-4">
          <p className="font-semibold text-ink-950">Fila para el lanzamiento de unas zapatillas</p>
          <p className="mt-1 text-small text-ink-600">
            Sábado · desde las 05:00 · 5 horas · Providencia
          </p>
        </div>

        <p className="mt-5 text-label text-ink-500 uppercase">Ofertas que llegan</p>
        <ul className="mt-2.5 space-y-2.5">
          {[
            { initial: "C", name: "Camila F.", rate: "$9.000/h", level: "Experta" },
            { initial: "T", name: "Tomás R.", rate: "$11.500/h", level: "Experto" },
            { initial: "D", name: "Daniela P.", rate: "$10.000/h", level: "Pro" },
          ].map((offer) => (
            <li
              key={offer.name}
              className="flex items-center gap-3 rounded-[var(--radius-control)] border border-line px-3 py-2.5"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-small font-semibold text-brand-700">
                {offer.initial}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small font-medium text-ink-950">
                  {offer.name}
                </span>
                <span className="block text-caption text-ink-500">{offer.level}</span>
              </span>
              <span className="shrink-0 text-small font-semibold text-ink-950 tabular-nums">
                {offer.rate}
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-5 flex items-start gap-2.5 rounded-[var(--radius-control)] bg-success-50 p-3.5 text-small text-success-800">
          <ShieldCheck size={17} className="mt-px shrink-0 text-success-600" aria-hidden="true" />
          El pago queda asociado al trabajo y se libera cuando lo apruebas.
        </p>
      </div>
    </div>
  );
}

/** Las tres razones por las que alguien deja que un desconocido haga su trámite. */
function TrustStrip() {
  const items = [
    {
      icon: ShieldCheck,
      title: "Perfiles verificados",
      body: "Personas reales, con identidad validada antes de poder ofertar.",
      tone: "text-success-600",
    },
    {
      icon: Lock,
      title: site.protectedPaymentLabel,
      body: "Tu dinero queda asociado al trabajo hasta que lo apruebas.",
      tone: "text-brand-600",
    },
    {
      icon: Headphones,
      title: "Soporte durante el trabajo",
      body: "Si algo se sale del plan, hay dónde reclamar y quién lo revisa.",
      tone: "text-ink-700",
    },
  ] as const;

  return (
    <div className="border-t border-line bg-canvas-warm">
      <ul className="container-page grid gap-6 py-6 sm:grid-cols-3 sm:gap-8 sm:py-7">
        {items.map((item) => (
          <li key={item.title} className="flex gap-3">
            <item.icon size={20} className={`mt-0.5 shrink-0 ${item.tone}`} aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-small font-semibold text-ink-950">{item.title}</p>
              <p className="mt-0.5 text-caption text-ink-600">{item.body}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="container-page pb-6 text-caption text-ink-500 sm:hidden">
        <Link href="/pago-protegido" className="font-medium underline underline-offset-2">
          Cómo protegemos tu dinero
        </Link>
      </p>
    </div>
  );
}
