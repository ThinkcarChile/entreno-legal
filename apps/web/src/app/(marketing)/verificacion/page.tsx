import type { Metadata } from "next";

import { Section } from "@/components/ui";
import { VerificationStatus } from "@/lib/domain/enums";
import { verificationStatusLabels } from "@/lib/domain/labels";

export const metadata: Metadata = {
  title: "Verificación de identidad",
  description:
    "Cómo verificamos a las personas que hacen filas y trámites, y qué datos se muestran públicamente.",
  alternates: { canonical: "/verificacion" },
};

const states = [
  VerificationStatus.UNVERIFIED,
  VerificationStatus.PENDING,
  VerificationStatus.VERIFIED,
  VerificationStatus.REJECTED,
  VerificationStatus.SUSPENDED,
] as const;

export default function VerificationPage() {
  return (
    <>
      <section className="border-b border-line bg-surface py-16 sm:py-20">
        <div className="container-page max-w-3xl">
          <h1 className="text-h1 text-ink-950 sm:text-display">
            Verificación de identidad
          </h1>
          <p className="mt-4 text-lg text-ink-600">
            Ningún trabajador puede aceptar trabajos sin estar verificado. Es la base de la
            confianza entre personas que no se conocen.
          </p>
        </div>
      </section>

      <Section title="Estados de una cuenta">
        <ul className="grid max-w-3xl gap-3">
          {states.map((state) => (
            <li
              key={state}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4"
            >
              <span className="font-medium text-ink-950">
                {verificationStatusLabels[state].label}
              </span>
              <code className="rounded bg-ink-100 px-1.5 py-0.5 text-caption text-ink-600">
                {state}
              </code>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Qué es público y qué no" className="bg-surface">
        <div className="grid max-w-4xl gap-5 sm:grid-cols-2">
          <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
            <h2 className="font-semibold text-ink-950">Se muestra en el perfil</h2>
            <ul className="mt-3 space-y-2 text-[0.9375rem] text-ink-700">
              <li>Nombre e inicial del apellido</li>
              <li>Fotografía de perfil</li>
              <li>Identidad verificada</li>
              <li>Teléfono verificado</li>
              <li>Cuenta bancaria verificada</li>
              <li>Reputación, nivel y trabajos completados</li>
            </ul>
          </div>
          <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
            <h2 className="font-semibold text-ink-950">Nunca se muestra</h2>
            <ul className="mt-3 space-y-2 text-[0.9375rem] text-ink-700">
              <li>RUT y documento de identidad</li>
              <li>Selfie de verificación</li>
              <li>Apellido completo</li>
              <li>Teléfono y correo de contacto</li>
              <li>Cuenta bancaria</li>
              <li>Dirección particular</li>
            </ul>
          </div>
        </div>

        <p className="mt-6 max-w-3xl text-small text-ink-600">
          Estos datos se guardan en tablas separadas del perfil público, con reglas de acceso a
          nivel de base de datos. Cambiar un identificador en la dirección web no da acceso a la
          información privada de otra persona.
        </p>
      </Section>
    </>
  );
}
