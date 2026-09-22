import type { Metadata } from "next";

import Link from "next/link";

import {
  AlertTriangle,
  ClipboardList,
  CreditCard,
  Mail,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import { Alert, Card, CardContent } from "@/components/ui";
import { site } from "@/config/site";

export const metadata: Metadata = {
  title: "Ayuda y contacto",
  description: `Cómo resolver dudas y problemas en ${site.name}.`,
  alternates: { canonical: "/ayuda" },
};

/**
 * Centro de ayuda.
 *
 * Dice la verdad sobre el soporte: es un equipo pequeño que responde por
 * correo, no una mesa de ayuda telefónica de 24 horas. Prometer atención
 * inmediata a alguien que está de pie en una fila a las seis de la mañana es
 * exactamente la clase de promesa que destruye la confianza.
 */
const topics: readonly {
  icon: LucideIcon;
  title: string;
  body: string;
  href: string;
  linkLabel: string;
}[] = [
  {
    icon: ClipboardList,
    title: "Publicar y contratar",
    body: "Cómo se define el precio, qué pasa si nadie oferta y cómo elegir entre varias ofertas.",
    href: "/como-funciona",
    linkLabel: "Cómo funciona",
  },
  {
    icon: CreditCard,
    title: "Pagos y devoluciones",
    body: "Cuándo se cobra, cuándo se libera el dinero al trabajador y qué ocurre si cancelas.",
    href: "/pago-protegido",
    linkLabel: `Sobre ${site.protectedPaymentLabel}`,
  },
  {
    icon: ShieldCheck,
    title: "Verificación de identidad",
    body: "Qué se pide para poder trabajar, qué documentos se guardan y quién puede verlos.",
    href: "/verificacion",
    linkLabel: "Cómo verificamos",
  },
  {
    icon: AlertTriangle,
    title: "Qué no se puede pedir",
    body: "Trámites que exigen la presencia del titular, suplantación de identidad y encargos prohibidos.",
    href: "/reglas",
    linkLabel: "Reglas de uso",
  },
];

export default function HelpPage() {
  return (
    <div className="container-page max-w-4xl py-12 sm:py-16">
      <h1 className="text-h1 text-ink-950">Ayuda y contacto</h1>
      <p className="mt-4 max-w-2xl text-body text-ink-600">
        Casi todo lo que se pregunta está respondido aquí abajo. Si tu caso no aparece,
        escríbenos y lo revisamos.
      </p>

      <ul className="mt-8 grid gap-4 sm:grid-cols-2">
        {topics.map((topic) => (
          <li key={topic.title}>
            <Card className="h-full">
              <CardContent className="flex h-full flex-col">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] bg-brand-50 text-brand-700">
                  <topic.icon size={19} aria-hidden="true" />
                </span>
                <h2 className="mt-4 text-h3 text-ink-950">{topic.title}</h2>
                <p className="mt-2 flex-1 text-small text-ink-600">{topic.body}</p>
                <Link
                  href={topic.href}
                  className="mt-4 text-small font-medium text-brand-700 hover:underline"
                >
                  {topic.linkLabel}
                </Link>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      <h2 className="mt-12 text-h2 text-ink-950">Si algo sale mal durante un trabajo</h2>
      <ol className="mt-5 space-y-4">
        {[
          {
            title: "Habla primero por el chat del trabajo",
            body: "La mayoría de los problemas —un retraso, una fila más larga de lo previsto, un documento que falta— se resuelven en dos mensajes.",
          },
          {
            title: "Si no se resuelve, abre un reclamo",
            body: "Desde la página del trabajo, dentro del plazo indicado. El pago queda congelado mientras se revisa: no se libera al trabajador ni se devuelve automáticamente.",
          },
          {
            title: "Una persona del equipo revisa la evidencia",
            body: "Se mira lo que aportan los dos lados: check-in, fotos, mensajes y horarios. La resolución queda escrita en el trabajo.",
          },
        ].map((step, index) => (
          <li key={step.title} className="flex gap-4">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-950 text-small font-semibold text-white"
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

      <Alert
        tone="warning"
        title="No somos un servicio de emergencia"
        className="mt-10"
      >
        Si hay una emergencia médica, un delito en curso o riesgo para alguien, llama a los
        servicios de emergencia. {site.name} no atiende urgencias ni sustituye a la policía,
        a un servicio de salud ni a un abogado.
      </Alert>

      <Card className="mt-8">
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <Mail size={22} className="mt-0.5 shrink-0 text-brand-600" aria-hidden="true" />
            <div>
              <p className="font-semibold text-ink-950">Escríbenos</p>
              <p className="mt-1 text-small text-ink-600">
                Respondemos por correo en días hábiles. Somos un equipo pequeño: no hay atención
                telefónica ni soporte las 24 horas.
              </p>
            </div>
          </div>
          <a
            href={`mailto:${site.contactEmail}`}
            className="shrink-0 text-small font-medium text-brand-700 hover:underline"
          >
            {site.contactEmail}
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
