import type { Metadata } from "next";

import { Mail } from "lucide-react";

import { Card, CardContent } from "@/components/ui";
import { site } from "@/config/site";

export const metadata: Metadata = {
  title: "Contacto",
  description: `Escríbenos si tienes dudas sobre ${site.name}.`,
  alternates: { canonical: "/contacto" },
};

export default function ContactPage() {
  return (
    <div className="container-page max-w-3xl py-16 sm:py-20">
      <h1 className="text-3xl font-semibold tracking-tight text-ink-900">Contacto</h1>
      <p className="mt-4 text-ink-600">
        ¿Dudas sobre si tu encargo está permitido, o problemas con un trabajo en curso?
        Escríbenos y te respondemos.
      </p>

      <Card className="mt-8">
        <CardContent className="flex items-center gap-4">
          <Mail size={22} className="shrink-0 text-brand-600" aria-hidden="true" />
          <div>
            <p className="text-sm text-ink-500">Correo</p>
            <a
              href={`mailto:${site.contactEmail}`}
              className="text-base font-medium text-ink-900 hover:text-brand-700"
            >
              {site.contactEmail}
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
