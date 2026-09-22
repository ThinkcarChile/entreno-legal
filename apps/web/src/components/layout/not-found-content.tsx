import { ButtonLink } from "@/components/ui";

/**
 * Cuerpo de la página 404.
 *
 * Vive aparte porque hay tres sitios que la muestran y cada uno la envuelve
 * distinto: dentro de la aplicación y dentro del sitio público ya hay cabecera
 * y pie puestos por el layout, y fuera de los dos grupos no hay nada. La
 * versión antigua traía su propia cabecera y su propio `min-h-dvh`: dentro de
 * la aplicación eso pintaba el logotipo dos veces y dejaba una pantalla entera
 * en blanco antes del mensaje.
 */
export function NotFoundContent({
  title = "No encontramos esta página",
  description = "Puede que el trabajo ya no esté publicado o que el enlace esté equivocado.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="container-page flex flex-col items-center py-20 text-center sm:py-28">
      <p className="text-small font-semibold text-brand-700">Error 404</p>
      <h1 className="mt-3 text-h1 text-ink-950">{title}</h1>
      <p className="mt-3 max-w-md text-body text-ink-600">{description}</p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <ButtonLink href="/">Ir al inicio</ButtonLink>
        <ButtonLink href="/trabajos" variant="outline">
          Ver trabajos disponibles
        </ButtonLink>
      </div>
    </div>
  );
}
