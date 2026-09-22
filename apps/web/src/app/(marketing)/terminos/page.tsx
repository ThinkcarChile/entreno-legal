import type { Metadata } from "next";

import { site } from "@/config/site";

export const metadata: Metadata = {
  title: "Términos y condiciones",
  description: `Términos y condiciones de uso de ${site.name}.`,
  alternates: { canonical: "/terminos" },
};

export default function TermsPage() {
  return (
    <div className="container-page max-w-3xl py-16 sm:py-20">
      <h1 className="text-h1 text-ink-950">
        Términos y condiciones
      </h1>
      <p className="mt-4 text-ink-600">
        Documento en preparación. Antes de abrir el servicio al público, esta página contendrá el
        texto legal revisado que rige la relación entre {site.name}, los clientes y los
        trabajadores.
      </p>

      <div className="mt-8 space-y-4 text-[0.9375rem] text-ink-700">
        <p>
          Mientras tanto, las reglas operativas vigentes son las publicadas en la página de
          reglas de uso: no se permite la suplantación de identidad, ni realizar trámites que
          exijan la presencia del titular, ni ninguna acción ilegal.
        </p>
        <p>
          {site.name} actúa como intermediario tecnológico entre personas. No es empleador de los
          trabajadores ni parte del encargo acordado entre cliente y trabajador.
        </p>
        <p>Contacto: {site.contactEmail}</p>
      </div>
    </div>
  );
}
