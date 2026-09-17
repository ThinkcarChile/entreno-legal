import { CircleDollarSign, FileCheck2, Lock, ShieldCheck } from "lucide-react";

import { site } from "@/config/site";

const guarantees = [
  {
    icon: Lock,
    title: "El dinero queda asociado al trabajo",
    description:
      "Al contratar, el pago se confirma y queda vinculado a ese servicio específico. No se libera antes de tiempo.",
  },
  {
    icon: FileCheck2,
    title: "Evidencia de todo el proceso",
    description:
      "Check-in con hora y ubicación, fotos, actualizaciones y código de entrega. Todo queda registrado.",
  },
  {
    icon: CircleDollarSign,
    title: "Se libera cuando el servicio termina",
    description:
      "Confirmas la entrega o se aprueba automáticamente al vencer el plazo para reportar un problema.",
  },
];

export function ProtectedPayment() {
  return (
    <section className="bg-ink-950 py-16 text-white sm:py-24">
      <div className="container-page grid gap-12 lg:grid-cols-2 lg:items-center lg:gap-16">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-sm font-medium text-white">
            <ShieldCheck size={15} aria-hidden="true" />
            {site.protectedPaymentLabel}
          </p>
          <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
            Tranquilidad para los dos lados
          </h2>
          <p className="mt-5 max-w-lg text-lg text-ink-300">
            El trabajador sabe que el dinero está disponible y tú mantienes la protección hasta
            que el servicio se complete.
          </p>
          <p className="mt-6 max-w-lg text-sm text-ink-400">
            Los pagos se procesan con Webpay Plus de Transbank. HagoTuFila nunca almacena los
            datos de tu tarjeta.
          </p>
        </div>

        <ul className="space-y-4">
          {guarantees.map((item) => (
            <li
              key={item.title}
              className="flex gap-4 rounded-[var(--radius-card)] bg-white/5 p-5 ring-1 ring-white/10 ring-inset"
            >
              <item.icon size={20} className="mt-0.5 shrink-0 text-brand-300" aria-hidden="true" />
              <div>
                <h3 className="font-semibold">{item.title}</h3>
                <p className="mt-1.5 text-sm text-ink-300">{item.description}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
