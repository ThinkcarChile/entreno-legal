import type { Metadata } from "next";

import { AmountRange, Card, CardContent, Section } from "@/components/ui";
import { platform } from "@/config/platform";
import { CategoryGroup } from "@/lib/domain/enums";
import { getData } from "@/lib/data";

export const metadata: Metadata = {
  title: "Precios sugeridos",
  description:
    "Cuánto cuesta que alguien haga tu fila o un trámite en Chile. Rangos sugeridos por categoría y cómo se calcula la comisión.",
  alternates: { canonical: "/precios" },
};

export default async function PricingPage() {
  const categories = await getData().categories.list();

  return (
    <>
      <section className="border-b border-ink-200/60 bg-white py-16 sm:py-20">
        <div className="container-page max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-tight text-ink-900 sm:text-4xl">
            Precios sugeridos
          </h1>
          <p className="mt-4 text-lg text-ink-600">
            HagoTuFila sugiere un rango por hora para cada trabajo. No fija el precio: cada
            trabajador decide cuánto cobrar y tú eliges la oferta que prefieras.
          </p>
        </div>
      </section>

      <Section title="Rangos de referencia por categoría">
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-ink-200/70 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-100 bg-ink-50/60">
              <tr>
                <th scope="col" className="px-5 py-3 font-semibold text-ink-700">
                  Categoría
                </th>
                <th scope="col" className="px-5 py-3 font-semibold text-ink-700">
                  Tipo
                </th>
                <th scope="col" className="px-5 py-3 text-right font-semibold text-ink-700">
                  Por hora
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {categories.map((category) => (
                <tr key={category.id}>
                  <td className="px-5 py-3.5 font-medium text-ink-900">{category.name}</td>
                  <td className="px-5 py-3.5 text-ink-600">
                    {category.group === CategoryGroup.FILA ? "Hacer una fila" : "Trámite o gestión"}
                  </td>
                  <td className="px-5 py-3.5 text-right text-ink-900 tabular-nums">
                    <AmountRange min={category.baseHourlyMin} max={category.baseHourlyMax} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-sm text-ink-500">
          Sobre estos rangos se aplican ajustes por horario nocturno, fin de semana, feriado,
          urgencia, duración, región y comuna.
        </p>
      </Section>

      <Section title="Comisión y cobros" className="bg-white">
        <div className="grid gap-5 sm:grid-cols-3">
          <Card>
            <CardContent>
              <h3 className="font-semibold text-ink-900">Publicar es gratis</h3>
              <p className="mt-2 text-sm text-ink-600">
                No cobramos por publicar ni por recibir ofertas. Solo hay cobro cuando aceptas
                una oferta y el trabajo se concreta.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <h3 className="font-semibold text-ink-900">
                Comisión de {(platform.commissionBps / 100).toLocaleString("es-CL")}%
              </h3>
              <p className="mt-2 text-sm text-ink-600">
                Se aplica sobre el monto del servicio y sostiene la verificación de identidad,
                el soporte y la protección del pago.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <h3 className="font-semibold text-ink-900">Bono aparte</h3>
              <p className="mt-2 text-sm text-ink-600">
                El bono por objetivo es adicional al pago por trabajo y llega completo al
                trabajador cuando el objetivo se cumple.
              </p>
            </CardContent>
          </Card>
        </div>
      </Section>
    </>
  );
}
