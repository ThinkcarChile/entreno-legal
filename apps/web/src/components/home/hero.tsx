import { ArrowRight, BadgeCheck, CheckCircle2, ListChecks, ShieldCheck } from "lucide-react";

import { HomeSearch } from "@/components/home/home-search";
import { ButtonLink } from "@/components/ui";
import { site } from "@/config/site";

import type { JobCategory } from "@/lib/domain/types";

/**
 * Portada: lo primero y, para mucha gente, lo único que se lee.
 *
 * Dice qué es el servicio en una frase, deja buscar sin registrarse y nombra
 * las tres cosas que decide alguien que nunca ha delegado un trámite: quién va,
 * qué pasa con su dinero y cómo sabe lo que está pasando.
 *
 * No hay cifras de uso. Con un producto que todavía no tiene volumen, un
 * «1.047 trabajos completados» sería inventado, y la confianza es exactamente
 * lo que se está vendiendo.
 */
export function Hero({ categories }: { categories: readonly JobCategory[] }) {
  return (
    <section className="container-page pt-5 sm:pt-8">
      <div className="relative grid overflow-hidden rounded-[1.25rem] bg-brand-950 px-6 py-9 text-white sm:rounded-[var(--radius-hero)] sm:px-10 sm:py-12 lg:min-h-[25.5rem] lg:grid-cols-[1.15fr_0.85fr] lg:gap-9 lg:px-14 lg:py-16">
        <div className="relative">
          <p className="text-label text-accent-300 uppercase">Tu tiempo vale</p>

          <h1 className="mt-4 max-w-[44rem] text-[2.5rem] leading-[1.06] font-extrabold tracking-[-0.06em] sm:text-[3.25rem] lg:text-[clamp(2.75rem,4.8vw,4.25rem)]">
            Tu lugar está <span className="text-accent-300">asegurado.</span> Tu día sigue.
          </h1>

          <p className="mt-5 max-w-[34rem] text-[0.9375rem] text-brand-100 sm:text-[1.0625rem]">
            Alguien verificado hace la fila por ti. Tú eliges la oferta, sigues el avance y el
            pago queda protegido hasta que el trabajo se cumple.
          </p>

          <div className="mt-7 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
            <ButtonLink href="/publicar" size="lg" variant="accent">
              Publicar un trabajo
              <ArrowRight size={17} aria-hidden="true" />
            </ButtonLink>
            <ButtonLink
              href="/trabajar"
              size="lg"
              variant="outline"
              className="border-white bg-white text-brand-950 hover:border-brand-100 hover:bg-brand-100"
            >
              Quiero ganar dinero
            </ButtonLink>
          </div>
        </div>

        <HeroArt />
      </div>

      <TrustStrip />

      <div className="mt-2 mb-4">
        <HomeSearch categories={categories} />
      </div>
    </section>
  );
}

/**
 * La ilustración del lado derecho: un aviso como el que recibe el cliente
 * cuando el trabajador llega.
 *
 * Es decorativa y se oculta a los lectores de pantalla: el nombre y la hora
 * son de ejemplo, no de nadie. En pantallas angostas desaparece, porque ahí
 * el espacio es para el texto y los botones.
 */
function HeroArt() {
  return (
    <div aria-hidden="true" className="relative hidden min-h-[17rem] self-center lg:block">
      <div className="absolute -top-7 right-0 h-[19.5rem] w-[19.5rem] rounded-full bg-brand-800" />

      <div className="absolute top-7 right-9 w-[17.75rem] -rotate-[7deg] rounded-[1.3rem] bg-white p-6 text-ink-950 shadow-[0_25px_30px_rgb(0_0_0/0.13)]">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2.5 py-1 text-[0.6875rem] font-extrabold text-success-800">
            <CheckCircle2 size={12} />
            Llegada verificada
          </span>
          <span className="text-small tabular-nums">08:42</span>
        </div>
        <p className="mt-4 text-[1.1875rem] leading-tight font-bold tracking-[-0.025em]">
          ¡Ya estoy en la fila!
        </p>
        <div className="mt-3 flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-warning-200 text-h3 font-bold text-brand-950">
            C
          </span>
          <span>
            <span className="block font-bold">Camilo M.</span>
            <span className="block text-small text-ink-500">Trabajador verificado</span>
          </span>
        </div>
        <div className="mt-4 h-2 w-3/4 rounded bg-ink-100" />
        <div className="mt-2.5 h-2 w-[45%] rounded bg-ink-100" />
        <p className="mt-6 flex items-center gap-1.5 border-t border-dashed border-ink-300 pt-3 font-extrabold">
          Pago Protegido activo
          <CheckCircle2 size={16} className="text-brand-700" />
        </p>
      </div>

      <p className="absolute -top-6 left-0 inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-accent-300 px-4 py-3 font-extrabold text-brand-950 shadow-[var(--shadow-card)]">
        <CheckCircle2 size={17} />
        Trabajo en marcha
      </p>
    </div>
  );
}

/** Las tres razones por las que alguien deja que un desconocido haga su trámite. */
function TrustStrip() {
  const items = [
    { icon: BadgeCheck, title: "Identidad verificada" },
    { icon: ShieldCheck, title: site.protectedPaymentLabel },
    { icon: ListChecks, title: "Seguimiento de cada etapa" },
  ] as const;

  return (
    <ul className="my-5 grid gap-2.5 sm:my-6 sm:grid-cols-3 sm:gap-4">
      {items.map((item) => (
        <li
          key={item.title}
          className="flex items-center gap-3 rounded-[1rem] border border-line bg-surface p-3 font-bold text-ink-950 sm:p-5"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[0.6875rem] bg-brand-100 text-brand-700">
            <item.icon size={19} aria-hidden="true" />
          </span>
          {item.title}
        </li>
      ))}
    </ul>
  );
}
