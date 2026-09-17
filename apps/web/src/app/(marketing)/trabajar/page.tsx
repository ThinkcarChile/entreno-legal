import type { Metadata } from "next";

import { BadgeCheck, Calendar, Coins, MapPinned } from "lucide-react";

import { ButtonLink, Card, CardContent, Section } from "@/components/ui";
import { site } from "@/config/site";

export const metadata: Metadata = {
  title: "Gana dinero haciendo filas y trámites",
  description:
    "Trabaja cuando quieras haciendo filas, trámites y encargos en tu comuna. Tú defines tu tarifa y tus zonas de trabajo.",
  alternates: { canonical: "/trabajar" },
};

const benefits = [
  { icon: Coins, title: "Tú defines tu tarifa", description: "Ofertas con el precio que consideres justo para cada trabajo." },
  { icon: Calendar, title: "Trabajas cuando quieras", description: "Eliges tu disponibilidad, incluidos turnos nocturnos si te acomodan." },
  { icon: MapPinned, title: "Cerca de donde estás", description: "Defines tus comunas y el radio en el que te mueves." },
  { icon: BadgeCheck, title: "Reputación que te acompaña", description: "Cada trabajo bien hecho sube tu nivel y te trae más clientes." },
];

export default function WorkWithUsPage() {
  return (
    <>
      <section className="border-b border-ink-200/60 bg-white py-16 sm:py-20">
        <div className="container-page max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-tight text-ink-900 sm:text-4xl">
            Tu tiempo puede valer más
          </h1>
          <p className="mt-4 text-lg text-ink-600">
            Haz filas, trámites y encargos para personas que necesitan delegar. Tú decides
            cuánto cobras, dónde trabajas y a qué hora.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <ButtonLink href="/crear-cuenta?modo=trabajador" size="lg">
              Crear cuenta de trabajador
            </ButtonLink>
            <ButtonLink href="/trabajos" variant="outline" size="lg">
              Ver trabajos disponibles
            </ButtonLink>
          </div>
        </div>
      </section>

      <Section title="Por qué trabajar con HagoTuFila">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {benefits.map((benefit) => (
            <Card key={benefit.title}>
              <CardContent>
                <benefit.icon size={22} className="text-brand-600" aria-hidden="true" />
                <h3 className="mt-4 font-semibold text-ink-900">{benefit.title}</h3>
                <p className="mt-1.5 text-sm text-ink-600">{benefit.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Antes de empezar" className="bg-white">
        <div className="max-w-3xl space-y-4 text-[0.9375rem] text-ink-700">
          <p>
            Para aceptar trabajos necesitas completar la verificación de identidad. Es
            obligatorio y es lo que sostiene la confianza de toda la plataforma.
          </p>
          <p>
            Tus datos personales (RUT, documento, teléfono y cuenta bancaria) nunca se muestran
            públicamente. En tu perfil solo se ven tu nombre, la inicial de tu apellido, tu foto,
            tus verificaciones y tu reputación.
          </p>
          <p>
            El pago del cliente se confirma antes de que empieces, así que sabes que el dinero
            está disponible. Tu pago se aprueba cuando el trabajo termina y el cliente confirma o
            vence el plazo de revisión. En {site.shortName} eso se llama{" "}
            {site.protectedPaymentLabel}.
          </p>
        </div>
      </Section>
    </>
  );
}
