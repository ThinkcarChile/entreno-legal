import { ArrowRight } from "lucide-react";

import { ButtonLink, Section } from "@/components/ui";
import { site } from "@/config/site";

/**
 * Cómo funciona, para los dos lados.
 *
 * Antes solo se contaba el lado del cliente, y la mitad de la gente que entra
 * viene a trabajar, no a contratar. Son dos columnas y no unas pestañas: sin
 * JavaScript se leen igual, y quien duda de qué lado está puede comparar los
 * dos caminos de una mirada.
 */
const client = {
  title: "Si necesitas que alguien vaya por ti",
  cta: { href: "/publicar", label: "Publicar un trabajo" },
  steps: [
    {
      title: "Publica lo que necesitas",
      body: "Qué hay que hacer, en qué comuna, a qué hora y por cuánto tiempo. Te sugerimos un rango de precio de referencia.",
    },
    {
      title: "Compara las ofertas que llegan",
      body: "Cada persona verificada propone su propia tarifa. Ves su reputación, sus trabajos completados y su puntualidad antes de elegir.",
    },
    {
      title: "Contratas y el pago queda protegido",
      body: `Al aceptar una oferta, el pago queda asociado a ese trabajo con ${site.protectedPaymentLabel}. No se libera antes de tiempo.`,
    },
    {
      title: "Sigues el trabajo y lo apruebas",
      body: "Avisos de llegada, check-in, fotos y actualizaciones. Al terminar, entregas un código y apruebas. Si algo sale mal, puedes reclamar.",
    },
  ],
} as const;

const worker = {
  title: "Si quieres ganar dinero con tu tiempo",
  cta: { href: "/trabajar", label: "Quiero trabajar" },
  steps: [
    {
      title: "Verifica tu identidad",
      body: "Nadie puede ofertar sin identidad validada. Es lo que hace que un desconocido te confíe su trámite.",
    },
    {
      title: "Oferta con tu propia tarifa",
      body: "Buscas por comuna, categoría y fecha, y propones cuánto cobras. No hay tarifa impuesta.",
    },
    {
      title: "Haces el trabajo con respaldo",
      body: "Recibes la dirección exacta al ser asignado, marcas que vas en camino, haces check-in y subes evidencia desde el teléfono.",
    },
    {
      title: "Cobras cuando se aprueba",
      body: "Pides el cierre, la persona aprueba y tu pago pasa a las ganancias por liquidar. Todo el historial queda a la vista.",
    },
  ],
} as const;

export function HowItWorks() {
  return (
    <Section
      eyebrow="Cómo funciona"
      title="El mismo trabajo, visto desde los dos lados"
      description="Nada ocurre a espaldas de nadie: cada paso deja registro para quien contrata y para quien trabaja."
      align="center"
      className="bg-surface"
    >
      <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
        <Track {...client} />
        <Track {...worker} accent={false} />
      </div>
    </Section>
  );
}

function Track({
  title,
  steps,
  cta,
  accent = true,
}: {
  title: string;
  steps: readonly { title: string; body: string }[];
  cta: { href: string; label: string };
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col rounded-[var(--radius-card)] border border-line bg-canvas p-6 sm:p-8">
      <h3 className="text-h3 text-ink-950">{title}</h3>

      <ol className="mt-6 flex-1 space-y-5">
        {steps.map((step, index) => (
          <li key={step.title} className="flex gap-4">
            <span
              aria-hidden="true"
              className={
                accent
                  ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-small font-semibold text-white"
                  : "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-950 text-small font-semibold text-white"
              }
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-ink-950">{step.title}</p>
              <p className="mt-1 text-small text-ink-600">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-7">
        <ButtonLink
          href={cta.href}
          variant={accent ? "primary" : "outline"}
          size="lg"
          fullWidth
        >
          {cta.label}
          <ArrowRight size={17} aria-hidden="true" />
        </ButtonLink>
      </div>
    </div>
  );
}
