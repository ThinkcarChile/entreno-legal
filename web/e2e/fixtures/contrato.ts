/**
 * CONTRATO ÚNICO DE LOS E2E.
 *
 * Todo spec de `e2e/flujos/` importa de acá y de ningún otro lado. La razón es
 * que seis flujos los escriben seis agentes en paralelo: si cada uno inventa su
 * forma de iniciar sesión, sus usuarios y su manera de limpiar, la suite no es
 * una suite, son seis scripts que se pisan en el mismo hogar.
 *
 * REGLAS QUE NO SE NEGOCIAN:
 *
 * 1. Los E2E corren SOLO contra STAGING. Nunca contra la base de la familia y
 *    nunca contra PGlite (la app habla PostgREST; PGlite no lo tiene). Sin
 *    `E2E_BASE_URL` cada describe se salta y el informe lo registra como
 *    NOT_RUN — jamás como PASS.
 * 2. Datos sintéticos. Ningún nombre, examen, boleta o valor real.
 * 3. Selectores por rol y texto visible (`getByRole`, `getByLabel`,
 *    `getByText`), en el español de la interfaz. Nada de clases CSS ni ids
 *    generados.
 * 4. Después de cada escritura importante: `recargar(page)` y volver a leer.
 *    Lo que solo vive en el estado de React no cuenta como persistido.
 * 5. La llave service_role se usa SOLO en `admin.ts` para preparar y limpiar.
 *    Nunca viaja al navegador ni aparece en un spec.
 */
import { test as base, expect, type Page } from "@playwright/test";

export type Usuario = "A" | "B" | "AJENO";

/** Las variables que staging tiene que definir. Nombres, nunca valores. */
export const ENV = {
  baseUrl: "E2E_BASE_URL",
  supabaseUrl: "E2E_SUPABASE_URL",
  anonKey: "E2E_SUPABASE_ANON_KEY",
  serviceRoleKey: "E2E_SUPABASE_SERVICE_ROLE_KEY",
  usuario: (u: Usuario) => ({ email: `E2E_USER_${u}_EMAIL`, password: `E2E_USER_${u}_PASSWORD` }),
} as const;

export const HAY_STAGING = Boolean(process.env[ENV.baseUrl]);

/** A y B comparten hogar; AJENO vive en OTRO hogar. Los tres son sintéticos. */
export function credenciales(u: Usuario): { email: string; password: string } {
  const claves = ENV.usuario(u);
  const email = process.env[claves.email];
  const password = process.env[claves.password];
  if (!email || !password) {
    throw new Error(`Faltan ${claves.email} / ${claves.password}: staging no está configurado.`);
  }
  return { email, password };
}

/**
 * Inicia sesión POR LA INTERFAZ, no inyectando cookies: el login es parte de lo
 * que se prueba. Deja al usuario en la página de inicio de su hogar.
 */
export async function iniciarSesion(page: Page, u: Usuario): Promise<void> {
  const { email, password } = credenciales(u);
  await page.goto("/login");
  await page.getByLabel(/correo/i).fill(email);
  await page.getByLabel(/contraseña/i).fill(password);
  await page.getByRole("button", { name: /entrar|iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

export async function cerrarSesion(page: Page): Promise<void> {
  await page.getByRole("button", { name: /cerrar sesión|salir/i }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Regla 4: recargar y esperar a que la página vuelva a estar lista. */
export async function recargar(page: Page): Promise<void> {
  await page.reload();
  await page.waitForLoadState("networkidle");
}

/**
 * Fecha del "hoy" de la app en Santiago, en YYYY-MM-DD. La app usa esta zona
 * horaria para todo lo que sea "hoy"; un spec que use la fecha de la máquina
 * falla a medianoche UTC.
 */
export function hoySantiago(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
}

/**
 * `test` con la regla 1 incorporada: sin staging, se salta con motivo. Los
 * specs usan ESTE `test`, no el de Playwright directo.
 */
export const test = base.extend<{
  exigeStaging: void;
  comoA: Page;
  comoB: Page;
  comoAjeno: Page;
}>({
  /**
   * EL SALTO POR FALTA DE STAGING VIVE EN UN FIXTURE, NO EN UN `beforeEach`.
   *
   * Antes esto era un `test.beforeEach` al final del módulo, y tenía un defecto
   * que solo se ve corriendo más de un archivo: el hook se registra AL IMPORTAR,
   * y con `workers: 1` un mismo worker carga varios archivos con el módulo ya en
   * caché. Resultado medido: el hook quedaba enganchado únicamente al PRIMER
   * archivo; los demás perdían el salto, su primer test reventaba adentro del
   * fixture `comoA` con "Faltan E2E_USER_A_EMAIL" y se reportaba FAILED. Sin
   * staging, la suite acusaba una falla que no existe — y un guardián que acusa
   * en falso se termina silenciando, que es justo lo que este archivo dice en su
   * encabezado que no puede pasar.
   *
   * `auto: true` lo resuelve de raíz: los fixtures se resuelven POR TEST, no por
   * registro de módulo, así que corre para todos los tests de todos los archivos
   * que usen este `test`, en cualquier orden y con cualquier número de workers.
   * Y va PRIMERO en la lista para que el salto ocurra antes de que `comoA` y sus
   * hermanos intenten leer las credenciales.
   */
  // eslint-disable-next-line no-empty-pattern -- un fixture `auto` que no depende
  // de ningún otro sigue necesitando el primer parámetro para llegar al tercero
  // (`testInfo`); es la forma que Playwright exige, no un descuido.
  exigeStaging: [
    async ({}, use, testInfo) => {
      testInfo.skip(!HAY_STAGING, "Sin E2E_BASE_URL: no hay staging. Estado: NOT_RUN.");
      await use();
    },
    { auto: true },
  ],
  comoA: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await iniciarSesion(page, "A");
    await use(page);
    await ctx.close();
  },
  comoB: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await iniciarSesion(page, "B");
    await use(page);
    await ctx.close();
  },
  comoAjeno: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await iniciarSesion(page, "AJENO");
    await use(page);
    await ctx.close();
  },
});

export { expect };
