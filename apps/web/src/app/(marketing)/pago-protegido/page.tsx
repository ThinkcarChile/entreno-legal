import type { Metadata } from "next";

import { ProtectedPayment } from "@/components/home/protected-payment";
import { Card, CardContent, Section } from "@/components/ui";
import { platform } from "@/config/platform";
import { site } from "@/config/site";

export const metadata: Metadata = {
  title: site.protectedPaymentLabel,
  description:
    "Cómo protege HagoTuFila el dinero de cada trabajo: pago confirmado antes de comenzar, evidencia del servicio y liberación al finalizar.",
  alternates: { canonical: "/pago-protegido" },
};

const steps = [
  { title: "Contratas", description: "Aceptas la oferta del trabajador que elegiste." },
  { title: "Pagas en la pasarela", description: "El cobro lo procesa la pasarela de pago. No guardamos los datos de tu tarjeta." },
  { title: "Pago confirmado", description: "El monto queda asociado a ese trabajo específico." },
  { title: "El trabajo comienza", description: "Recién con el pago confirmado el trabajador puede empezar." },
  { title: "Sigues el avance", description: "Check-in, fotos, actualizaciones y código de entrega." },
  {
    title: "Se libera el pago",
    description: `Cuando confirmas la entrega o vencen las ${platform.disputeWindowHours} horas para reportar un problema.`,
  },
];

export default function ProtectedPaymentPage() {
  return (
    <>
      <section className="border-b border-line bg-surface py-16 sm:py-20">
        <div className="container-page max-w-3xl">
          <h1 className="text-h1 text-ink-950 sm:text-display">
            {site.protectedPaymentLabel}
          </h1>
          <p className="mt-4 text-lg text-ink-600">
            El trabajador sabe que el dinero está disponible y tú mantienes la protección hasta
            que el servicio se complete.
          </p>
        </div>
      </section>

      <Section title="Paso a paso">
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((step, index) => (
            <li key={step.title}>
              <Card className="h-full">
                <CardContent>
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-small font-semibold text-white">
                    {index + 1}
                  </span>
                  <h3 className="mt-4 font-semibold text-ink-950">{step.title}</h3>
                  <p className="mt-1.5 text-small text-ink-600">{step.description}</p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      </Section>

      <ProtectedPayment />

      <Section title="Lo que no hacemos" className="bg-surface">
        <ul className="grid max-w-3xl gap-3 text-[0.9375rem] text-ink-700">
          <li>No guardamos ni procesamos directamente los datos de tu tarjeta.</li>
          <li>No existe una billetera con saldo retirable para clientes.</li>
          <li>No liberamos el pago antes de que el servicio termine.</li>
          <li>No eliminamos evidencia asociada a un trabajo o a una disputa.</li>
        </ul>
      </Section>
    </>
  );
}
