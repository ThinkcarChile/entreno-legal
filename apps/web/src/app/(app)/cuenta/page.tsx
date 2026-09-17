import type { Metadata } from "next";

import { BadgeCheck, Gift, Star, UserRound, Wallet } from "lucide-react";

import { Card, CardContent, ButtonLink } from "@/components/ui";
import { site } from "@/config/site";

export const metadata: Metadata = {
  title: "Mi cuenta",
  robots: { index: false, follow: false },
};

const areas = [
  { icon: UserRound, title: "Perfil público", description: "Nombre, inicial del apellido, foto y descripción." },
  { icon: BadgeCheck, title: "Verificación", description: "Documento, selfie y teléfono. Obligatorio para aceptar trabajos." },
  { icon: Wallet, title: "Datos de pago", description: "Cuenta bancaria para recibir tus pagos. Nunca se muestra en público." },
  { icon: Star, title: "Reputación", description: "Tu Índice de Confianza, nivel y reseñas recibidas." },
  { icon: Gift, title: site.loyaltyLabel, description: "Puntos acumulados, canjeables como descuento sobre la comisión." },
];

export default function AccountPage() {
  return (
    <div className="container-page py-8 sm:py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Mi cuenta</h1>
      <p className="mt-2 max-w-2xl text-ink-600">
        Entra a tu cuenta para gestionar tu perfil, tu verificación y tus pagos. La misma cuenta
        sirve para contratar y para trabajar.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <ButtonLink href="/entrar">Entrar</ButtonLink>
        <ButtonLink href="/crear-cuenta" variant="outline">
          Crear cuenta
        </ButtonLink>
      </div>

      <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {areas.map((area) => (
          <li key={area.title}>
            <Card className="h-full">
              <CardContent>
                <area.icon size={20} className="text-brand-600" aria-hidden="true" />
                <h2 className="mt-4 font-semibold text-ink-900">{area.title}</h2>
                <p className="mt-1.5 text-sm text-ink-600">{area.description}</p>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
