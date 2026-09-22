import type { Metadata } from "next";

import { CheckCircle2, XCircle } from "lucide-react";

import { Section } from "@/components/ui";

export const metadata: Metadata = {
  title: "Reglas de uso",
  description:
    "Qué se puede y qué no se puede pedir en HagoTuFila. Reglas claras para que el servicio sea legal y seguro.",
  alternates: { canonical: "/reglas" },
};

const allowed = [
  "Hacer una fila y mantener el lugar hasta que llegue el cliente.",
  "Esperar un turno de atención y avisar cuando se acerque.",
  "Retirar un pedido cuando el comercio permite el retiro por terceros.",
  "Entregar o retirar documentos cuando el trámite lo permite expresamente.",
  "Esperar la visita de un técnico y acompañar la atención.",
  "Filas de madrugada, overnight y de larga duración.",
];

const forbidden = [
  "Suplantar la identidad de otra persona, por cualquier medio.",
  "Realizar un trámite que legalmente exige la presencia del titular.",
  "Firmar documentos a nombre de otra persona.",
  "Comprar productos ilegales o de venta restringida.",
  "Cualquier acción ilegal, aunque ambas partes estén de acuerdo.",
  "Hacer fila donde el establecimiento lo prohíbe expresamente.",
];

export default function RulesPage() {
  return (
    <>
      <section className="border-b border-line bg-surface py-16 sm:py-20">
        <div className="container-page max-w-3xl">
          <h1 className="text-h1 text-ink-950 sm:text-display">
            Reglas de uso
          </h1>
          <p className="mt-4 text-lg text-ink-600">
            HagoTuFila existe para ahorrarte tiempo, no para saltarse reglas. Estas condiciones
            aplican a clientes y trabajadores por igual.
          </p>
        </div>
      </section>

      <Section>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-[var(--radius-card)] border border-success-100 bg-success-50/50 p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-success-800">
              <CheckCircle2 size={20} aria-hidden="true" />
              Lo que sí se puede
            </h2>
            <ul className="mt-4 space-y-2.5">
              {allowed.map((item) => (
                <li key={item} className="flex gap-2.5 text-[0.9375rem] text-ink-700">
                  <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-success-600" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-[var(--radius-card)] border border-danger-100 bg-danger-50/50 p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-danger-800">
              <XCircle size={20} aria-hidden="true" />
              Lo que nunca se permite
            </h2>
            <ul className="mt-4 space-y-2.5">
              {forbidden.map((item) => (
                <li key={item} className="flex gap-2.5 text-[0.9375rem] text-ink-700">
                  <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-danger-600" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p className="mt-8 max-w-3xl text-small text-ink-600">
          Publicar un encargo que infrinja estas reglas implica su retiro inmediato y puede
          derivar en la suspensión de la cuenta. Si tienes dudas sobre si tu encargo está
          permitido, escríbenos antes de publicarlo.
        </p>
      </Section>
    </>
  );
}
