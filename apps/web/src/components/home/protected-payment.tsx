import Link from "next/link";

import { CircleDollarSign, FileCheck2, Lock, MessageSquareWarning, ShieldCheck } from "lucide-react";

import { site } from "@/config/site";

/**
 * Seguridad.
 *
 * El bloque oscuro de la página: rompe el crema y marca que aquí se habla de
 * dinero. Cuatro garantías concretas y verificables, ninguna promesa que el
 * producto no cumpla hoy.
 *
 * `ink-300` sobre `ink-950` llega a 9:1 y `ink-400` a 5,6:1; por eso el texto
 * secundario de este bloque no baja de `ink-400`.
 */
const guarantees = [
  {
    icon: Lock,
    title: "El dinero queda asociado al trabajo",
    description:
      "Al contratar, el pago se confirma y queda vinculado a ese servicio. No se libera antes de tiempo ni por error.",
  },
  {
    icon: FileCheck2,
    title: "Evidencia de todo el proceso",
    description:
      "Aviso de llegada, check-in con hora del servidor, fotos, actualizaciones y código de entrega. Todo queda registrado.",
  },
  {
    icon: CircleDollarSign,
    title: "Se libera cuando el servicio termina",
    description:
      "El trabajador pide el cierre; tú apruebas. Su botón no libera el dinero por sí solo en ningún caso.",
  },
  {
    icon: MessageSquareWarning,
    title: "Si algo sale mal, hay reclamo",
    description:
      "Puedes abrir un reclamo dentro del plazo. El pago se congela y una persona del equipo revisa la evidencia de los dos lados.",
  },
] as const;

export function ProtectedPayment() {
  return (
    <section className="bg-ink-950 py-14 text-white sm:py-20">
      <div className="container-page grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
        <div>
          <p className="inline-flex items-center gap-2 rounded-[var(--radius-pill)] bg-white/10 px-3 py-1.5 text-small font-medium text-white">
            <ShieldCheck size={15} aria-hidden="true" />
            {site.protectedPaymentLabel}
          </p>
          <h2 className="mt-5 text-h2 sm:text-[2rem]">Tranquilidad para los dos lados</h2>
          <p className="mt-4 max-w-lg text-body text-ink-300 sm:text-[1.0625rem]">
            El trabajador sabe que el dinero está disponible y tú mantienes la protección hasta
            que el servicio se complete.
          </p>
          <p className="mt-5 max-w-lg text-small text-ink-500">
            {site.name} nunca almacena los datos de tu tarjeta: el cobro lo procesa la pasarela
            de pago, no nosotros.
          </p>
          <p className="mt-6">
            <Link
              href="/pago-protegido"
              className="text-small font-medium text-white underline underline-offset-4 hover:text-brand-200"
            >
              Cómo protegemos tu dinero
            </Link>
          </p>
        </div>

        <ul className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-1">
          {guarantees.map((item) => (
            <li
              key={item.title}
              className="flex gap-4 rounded-[var(--radius-card)] bg-white/5 p-5 ring-1 ring-white/10 ring-inset"
            >
              <item.icon size={20} className="mt-0.5 shrink-0 text-brand-300" aria-hidden="true" />
              <div className="min-w-0">
                <h3 className="font-semibold">{item.title}</h3>
                <p className="mt-1.5 text-small text-ink-300">{item.description}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
