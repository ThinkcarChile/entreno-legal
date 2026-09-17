import { Section } from "@/components/ui";

const steps = [
  {
    number: "1",
    title: "Publica lo que necesitas",
    description:
      "Cuenta qué necesitas, dónde, cuándo y por cuánto tiempo. Te sugerimos un rango de precio justo para ese trabajo.",
  },
  {
    number: "2",
    title: "Recibe ofertas de personas verificadas",
    description:
      "Cada trabajador propone su propia tarifa. Compara reputación, puntualidad y experiencia antes de decidir.",
  },
  {
    number: "3",
    title: "Elige, paga de forma segura y sigue el trabajo",
    description:
      "Pagas con Webpay y sigues el avance en tiempo real: check-in, fotos, actualizaciones y entrega con código.",
  },
];

export function HowItWorks() {
  return (
    <Section
      eyebrow="Cómo funciona"
      title="Tres pasos, sin complicaciones"
      description="Desde que publicas hasta que el trabajo termina, todo queda registrado en un mismo lugar."
      align="center"
    >
      <ol className="grid gap-6 sm:grid-cols-3 sm:gap-8">
        {steps.map((step) => (
          <li
            key={step.number}
            className="rounded-[var(--radius-card)] border border-ink-200/70 bg-white p-6"
          >
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand-600 text-base font-semibold text-white">
              {step.number}
            </span>
            <h3 className="mt-5 text-lg font-semibold text-ink-900">{step.title}</h3>
            <p className="mt-2 text-[0.9375rem] text-ink-600">{step.description}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
