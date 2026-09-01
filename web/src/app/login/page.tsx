import { Card, ErrorNote, Icon } from "@/components/ui";
import { signIn, signUp } from "./actions";

interface Props {
  searchParams: Promise<{ error?: string; next?: string }>;
}

/**
 * Puerta de entrada: una sola columna centrada, sin navegación (todavía no hay
 * sesión que navegar). Campos de 48 px y botones a lo ancho — esto se abre
 * parado, con una mano.
 */
const CAMPO =
  "w-full min-h-[48px] rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-3 font-body-md text-body-md text-on-surface";

const ETIQUETA = "mb-1 block font-body-sm text-body-sm font-semibold text-on-surface";

export default async function LoginPage({ searchParams }: Props) {
  const { error, next } = await searchParams;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-container-margin py-xl">
      <div className="w-full max-w-[24rem]">
        <div className="flex flex-col items-center text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-fixed text-on-primary-fixed">
            <Icon name="family_restroom" className="text-[32px]" />
          </span>
          {/*
            Este h1 es la PRIMERA marca que lee cualquiera, y durante un sprint
            entero dijo una marca distinta a la del manifiesto: en el cajón de
            Android aparecía un nombre y al tocarlo se abría otro. Nadie lo caza
            leyendo código, porque cada archivo por separado se ve bien.
            La marca vieja quedó prohibida en todo el árbol y lo vigila
            pwa-coherencia.test.ts ("la marca muerta no vive en ninguna parte").
          */}
          <h1 className="mt-md font-headline-lg-mobile text-headline-lg-mobile text-primary">
            NutriFamilia
          </h1>
          <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
            Inicia sesión o crea tu cuenta.
          </p>
        </div>

        {error ? (
          <div className="mt-md">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}

        <Card className="mt-lg">
          <form className="space-y-md p-md">
            <input type="hidden" name="next" value={next ?? "/family"} />
            <label className="block">
              <span className={ETIQUETA}>Correo</span>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                className={CAMPO}
              />
            </label>
            <label className="block">
              <span className={ETIQUETA}>Contraseña</span>
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete="current-password"
                className={CAMPO}
              />
            </label>
            <div className="space-y-sm pt-xs">
              <button
                formAction={signIn}
                className="inline-flex w-full items-center justify-center gap-sm rounded-full bg-primary px-lg py-3 font-body-md text-body-md font-semibold text-on-primary transition-transform active:scale-95"
              >
                <Icon name="login" className="text-[18px]" />
                Entrar
              </button>
              <button
                formAction={signUp}
                className="inline-flex w-full items-center justify-center gap-sm rounded-full border border-outline px-lg py-3 font-body-md text-body-md font-semibold text-on-surface-variant transition-transform active:scale-95"
              >
                <Icon name="person_add" className="text-[18px]" />
                Crear cuenta
              </button>
            </div>
          </form>
        </Card>
      </div>
    </main>
  );
}
