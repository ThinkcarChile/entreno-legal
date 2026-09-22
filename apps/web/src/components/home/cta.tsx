import { ButtonLink } from "@/components/ui";

export function FinalCta() {
  return (
    <section className="border-t border-line bg-canvas py-14 sm:py-20">
      <div className="container-page">
        <div className="rounded-[var(--radius-card)] border border-line bg-surface px-6 py-12 text-center sm:px-12">
          <h2 className="text-h2 text-ink-950 sm:text-[2rem]">
            Deja de perder horas en una fila
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-body text-ink-600">
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
