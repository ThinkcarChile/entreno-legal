import { ButtonLink } from "@/components/ui";

export function FinalCta() {
  return (
    <section className="border-t border-ink-200/60 bg-canvas py-16 sm:py-20">
      <div className="container-page">
        <div className="rounded-[var(--radius-card)] border border-ink-200/70 bg-white px-6 py-12 text-center sm:px-12">
          <h2 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">
            Deja de perder horas en una fila
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-ink-600">
            Publica lo que necesitas en menos de dos minutos y recibe ofertas de personas
            verificadas cerca de ti.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <ButtonLink href="/publicar" size="lg">
              Necesito ayuda
            </ButtonLink>
            <ButtonLink href="/trabajar" variant="outline" size="lg">
              Quiero ganar dinero
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}
