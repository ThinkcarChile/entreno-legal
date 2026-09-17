import type { Metadata } from "next";

import { FinalCta } from "@/components/home/cta";
import { HowItWorks } from "@/components/home/how-it-works";
import { ProtectedPayment } from "@/components/home/protected-payment";
import { Section } from "@/components/ui";
import { platform } from "@/config/platform";

export const metadata: Metadata = {
  title: "Cómo funciona",
  description:
    "Publicar, recibir ofertas, pagar de forma protegida y seguir el trabajo en tiempo real. Así funciona HagoTuFila en todo Chile.",
  alternates: { canonical: "/como-funciona" },
};

const clientFlow = [
  "Publicas qué necesitas, dónde, cuándo y por cuánto tiempo.",
  "Te sugerimos un rango de precio por hora según categoría, zona y horario.",
  "Recibes ofertas de trabajadores verificados, cada uno con su propia tarifa.",
  "Eliges una oferta y pagas con Webpay. El dinero queda asociado a ese trabajo.",
  "Sigues el avance: llegada, check-in, fotos y actualizaciones.",
  "Confirmas la entrega con un código y dejas tu reseña.",
];

const workerFlow = [
  "Creas tu perfil y verificas tu identidad. Sin verificación no puedes aceptar trabajos.",
  "Defines tu tarifa, tus zonas de trabajo y tu disponibilidad.",
  "Buscas trabajos y envías ofertas con el precio que tú decidas.",
  "Cuando te aceptan y el pago está confirmado, puedes comenzar.",
  "Haces check-in, subes evidencia y mantienes informado al cliente.",
  "Al terminar, el cliente confirma y tu pago queda aprobado.",
];

export default function HowItWorksPage() {
  return (
    <>
      <section className="border-b border-ink-200/60 bg-white py-16 sm:py-20">
        <div className="container-page max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-tight text-ink-900 sm:text-4xl">
            Cómo funciona HagoTuFila
          </h1>
          <p className="mt-4 text-lg text-ink-600">
            Un marketplace entre personas, con reglas claras, identidad verificada y pagos
            protegidos de principio a fin.
          </p>
        </div>
      </section>

      <HowItWorks />

      <Section title="Si necesitas ayuda" className="bg-white">
        <ol className="grid gap-4 sm:grid-cols-2">
          {clientFlow.map((item, index) => (
            <li
              key={item}
              className="flex gap-3.5 rounded-[var(--radius-card)] border border-ink-200/70 bg-white p-5"
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700">
                {index + 1}
              </span>
              <p className="text-[0.9375rem] text-ink-700">{item}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Si quieres ganar dinero">
        <ol className="grid gap-4 sm:grid-cols-2">
          {workerFlow.map((item, index) => (
            <li
              key={item}
              className="flex gap-3.5 rounded-[var(--radius-card)] border border-ink-200/70 bg-white p-5"
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700">
                {index + 1}
              </span>
              <p className="text-[0.9375rem] text-ink-700">{item}</p>
            </li>
          ))}
        </ol>
      </Section>

      <ProtectedPayment />

      <Section title="Extensiones y disputas" className="bg-white">
        <div className="grid gap-5 sm:grid-cols-2">
          <article className="rounded-[var(--radius-card)] border border-ink-200/70 bg-white p-6">
            <h3 className="font-semibold text-ink-900">Si el trabajo se alarga</h3>
            <p className="mt-2 text-[0.9375rem] text-ink-600">
              Puedes solicitar una extensión de una, dos o cuatro horas, o el tiempo que
              necesites. El trabajador debe aceptarla y el costo adicional se autoriza antes de
              continuar. Nunca se asume que la persona seguirá trabajando.
            </p>
          </article>
          <article className="rounded-[var(--radius-card)] border border-ink-200/70 bg-white p-6">
            <h3 className="font-semibold text-ink-900">Si algo sale mal</h3>
            <p className="mt-2 text-[0.9375rem] text-ink-600">
              Tienes {platform.disputeWindowHours} horas desde el término del trabajo para
              reportar un problema. Mientras se revisa, el pago al trabajador queda retenido y
              toda la evidencia del trabajo se conserva íntegra.
            </p>
          </article>
        </div>
      </Section>

      <FinalCta />
    </>
  );
}
