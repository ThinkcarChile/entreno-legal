import type { Metadata } from "next";

import { site } from "@/config/site";

export const metadata: Metadata = {
  title: "Política de privacidad",
  description: `Cómo ${site.name} trata los datos personales de clientes y trabajadores.`,
  alternates: { canonical: "/privacidad" },
};

export default function PrivacyPage() {
  return (
    <div className="container-page max-w-3xl py-16 sm:py-20">
      <h1 className="text-3xl font-semibold tracking-tight text-ink-900">
        Política de privacidad
      </h1>
      <p className="mt-4 text-ink-600">
        Documento en preparación. Esta página contendrá el texto definitivo ajustado a la Ley
        19.628 y a la normativa chilena vigente sobre protección de datos personales.
      </p>

      <div className="mt-8 space-y-4 text-[0.9375rem] text-ink-700">
        <p>Principios que ya rigen el diseño del producto:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Los datos sensibles (RUT, documento, selfie, teléfono, correo de contacto y cuenta
            bancaria) se almacenan separados del perfil público y con acceso restringido.
          </li>
          <li>Nunca se almacenan datos de tarjetas de crédito o débito.</li>
          <li>
            La evidencia de un trabajo se conserva para resolver reclamos y no se elimina
            silenciosamente.
          </li>
          <li>Las acciones críticas quedan registradas en una bitácora de auditoría.</li>
        </ul>
        <p>Contacto: {site.contactEmail}</p>
      </div>
    </div>
  );
}
