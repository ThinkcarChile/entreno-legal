import { Card, Chip, Icon, LinkButton } from "@/components/ui";

/**
 * Gate final §7: NO EXISTE es un estado propio — ni error, ni vacío.
 *
 * El texto es deliberadamente ambiguo: nunca dice si el recurso existe y no es
 * tuyo, o si derechamente no existe. Un 404 que distingue esos dos casos es un
 * oráculo para adivinar qué hogares hay del otro lado.
 *
 * Sin AppShell (la ruta no pertenece a ninguna sección) y con el ancho
 * explícito: las utilidades de ancho con nombre corto resuelven a la escala de
 * espaciado del kit y darían 16 píxeles.
 */
export default function NoExiste() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-container-margin py-xl">
      <Card className="flex w-full max-w-[28rem] flex-col items-center gap-md p-lg text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-container text-on-surface-variant">
          <Icon name="search_off" className="text-[32px]" />
        </span>

        <Chip tono="neutro" icon="link_off">
          Página no disponible
        </Chip>

        <div>
          <h1 className="font-headline-md text-headline-md text-on-surface">
            No encontramos esta página
          </h1>
          <p className="mt-sm font-body-md text-body-md text-on-surface-variant">
            El enlace puede estar mal escrito o apuntar a algo que no está disponible acá. Vuelve al
            inicio y sigue desde ahí.
          </p>
        </div>

        <LinkButton href="/" className="mt-sm w-full min-h-[56px]">
          <Icon name="home" className="text-[18px]" />
          Volver al inicio
        </LinkButton>
      </Card>
    </main>
  );
}
