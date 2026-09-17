import { Section } from "@/components/ui";
import { site } from "@/config/site";

const faqs = [
  {
    question: "¿Cómo se define el precio?",
    answer:
      "Te sugerimos un rango por hora según la categoría, la región, el horario y la duración. Ese rango es una referencia: cada trabajador propone su propia tarifa al ofertar y tú eliges la oferta que prefieras.",
  },
  {
    question: "¿Qué pasa si el trabajo se alarga?",
    answer:
      "Puedes solicitar una extensión de una, dos, cuatro horas o el tiempo que necesites. El trabajador debe aceptarla y el costo adicional se autoriza antes de continuar. Nunca se asume que seguirá trabajando.",
  },
  {
    question: "¿Cómo sé que la persona es real?",
    answer:
      "Ningún trabajador puede aceptar trabajos sin estar verificado. En el perfil público verás identidad verificada, teléfono confirmado, reputación, trabajos completados y puntualidad.",
  },
  {
    question: "¿Cuándo recibe el dinero el trabajador?",
    answer: `Con ${site.protectedPaymentLabel}, el pago se confirma antes de empezar y queda asociado a ese trabajo. Se aprueba para el trabajador cuando confirmas la entrega o cuando vence el plazo para reportar un problema.`,
  },
  {
    question: "¿Qué cosas no se pueden pedir?",
    answer:
      "No se permite suplantar la identidad de nadie, hacer trámites que exigen la presencia del titular, comprar productos ilegales ni hacer filas donde el establecimiento lo prohíba expresamente.",
  },
  {
    question: "¿Funciona fuera de Santiago?",
    answer:
      "Sí. HagoTuFila opera en todo Chile. Al publicar eliges región y comuna, y verás trabajadores con zona de cobertura en ese lugar.",
  },
];

export function Faq() {
  return (
    <Section
      eyebrow="Preguntas frecuentes"
      title="Antes de publicar tu primer trabajo"
      className="bg-white"
    >
      <div className="mx-auto max-w-3xl divide-y divide-ink-100 border-y border-ink-100">
        {faqs.map((faq) => (
          <details key={faq.question} className="group py-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left font-medium text-ink-900">
              {faq.question}
              <span
                aria-hidden="true"
                className="shrink-0 text-xl leading-none text-ink-400 transition-transform group-open:rotate-45"
              >
                +
              </span>
            </summary>
            <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-600">{faq.answer}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

export { faqs };
