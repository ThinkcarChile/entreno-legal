import { signOut } from "@/app/login/actions";
import { AppShell } from "@/components/AppShell";
import { ButtonOutline, Card, ErrorNote, Icon, Notice } from "@/components/ui";

/**
 * EL ESTADO CONTROLADO DE UNA CUENTA SIN HOGAR.
 *
 * En la beta familiar se entra por invitación (ver `politica-hogar.ts`). Una
 * cuenta que existe pero no pertenece a ningún hogar no puede ver datos de
 * nadie —la RLS ya lo garantiza— y tampoco puede crearse un hogar propio. Lo
 * que ve es esto: qué le falta y cómo conseguirlo, sin un 500, sin un
 * formulario que la mande a ninguna parte, y con la puerta para salir.
 *
 * El componente vive en su archivo para poder renderizarse en un test sin
 * levantar la página entera de la familia.
 *
 * `mensaje` es SIEMPRE texto de nuestra lista de avisos (avisos.ts), resuelto
 * por la página desde un código; nunca texto libre de la URL. Antes recibía
 * `?error=` crudo y era una caja roja donde se podía pintar cualquier frase.
 */
export function SinHogar({ mensaje }: { mensaje?: string | null }) {
  return (
    <AppShell
      active="family"
      title="Todavía no tienes hogar"
      subtitle="Para entrar necesitas una invitación de tu familia."
    >
      <div className="mt-md space-y-md">
        {mensaje ? <ErrorNote>{mensaje}</ErrorNote> : null}
        <Notice icon="mail" tono="info">
          <p className="font-semibold">Pide una invitación</p>
          <p className="mt-1">
            El administrador de tu hogar puede generar un enlace desde su pantalla de familia.
            Ábrelo con esta misma cuenta y quedas adentro.
          </p>
        </Notice>
        <Card className="p-md">
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Entraste como una cuenta que todavía no pertenece a ningún hogar. Mientras tanto no
            hay nada que mostrar acá.
          </p>
        </Card>
        <form action={signOut} className="flex justify-center">
          <ButtonOutline type="submit">
            <Icon name="logout" className="text-[18px]" />
            Cerrar sesión
          </ButtonOutline>
        </form>
      </div>
    </AppShell>
  );
}
