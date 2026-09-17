import { defineConfig, devices } from "@playwright/test";

import { loadEnvLocal } from "./scripts/env-local.ts";

// Playwright no lee `.env.local` por su cuenta: eso lo hace Next al arrancar el
// servidor, y el proceso de las pruebas es otro. Sin esto, las cuentas de
// control de calidad no llegan a `e2e/fixtures.ts` y las seis pruebas del
// marketplace se omiten en silencio aunque las credenciales estén puestas, que
// es justo el resultado que aparenta éxito sin haber probado nada.
//
// `__dirname` y no `import.meta.url`: Playwright transpila este archivo a
// CommonJS antes de cargarlo, y ahí `import.meta` es un error de sintaxis.
loadEnvLocal(__dirname);

/**
 * Pruebas de extremo a extremo.
 *
 * Son pocas a propósito: cubren el recorrido que define la etapa y nada más.
 * Una suite grande de E2E se vuelve lenta y frágil, y termina ignorándose.
 *
 * La mayoría necesita un proyecto Supabase real. Sin credenciales, esas pruebas
 * se marcan como omitidas con el motivo a la vista, en vez de fallar y confundir.
 * `smoke.spec.ts` sí corre siempre: comprueba que la aplicación levanta.
 */
// `localhost` y no `127.0.0.1`: en desarrollo, Next bloquea sus propios recursos
// (`/_next/hmr`) cuando el origen no coincide con el del servidor. La página
// entonces no hidrata, el formulario de entrar cae al envío nativo del
// navegador y el correo y la contraseña acaban en la barra de direcciones.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3100";

export default defineConfig({
  testDir: "./e2e",
  // Secuencial: el recorrido comparte estado en la base (un trabajo, una oferta).
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "es-CL",
    timezoneId: "America/Santiago",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Algunos entornos (contenedores de integración continua) traen Chromium
        // instalado aparte, con una versión distinta a la que Playwright espera.
        // Si PLAYWRIGHT_CHROMIUM_PATH apunta a un binario, se usa ese en vez de
        // obligar a descargar otro.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],

  // Si ya hay algo escuchando en el puerto, se reutiliza.
  //
  // En modo desarrollo y no con `npm run start`, a propósito. `next start` corre
  // con NODE_ENV=production, y ahí el proveedor de pagos simulado está prohibido
  // por diseño: la aplicación se niega a iniciar un pago falso en producción.
  // Con el servidor en producción, el recorrido llegaba hasta el pago y se
  // quedaba mirando un botón «Pagar con Webpay» que todavía no existe. La
  // prohibición es correcta y se queda; lo que estaba mal era el entorno donde
  // se pedía recorrer un pago simulado.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev -- --port 3100",
        url: baseURL,
        reuseExistingServer: true,
        // Desarrollo compila cada ruta la primera vez que se visita.
        timeout: 180_000,
        // El servidor tiene que saber en qué URL vive. `NEXT_PUBLIC_SITE_URL`
        // es lo que usa el proveedor de pagos para construir la dirección de
        // retorno; con el valor de `.env.local` —el puerto 3000 de siempre— el
        // pago simulado devolvía el navegador a un puerto donde no escucha
        // nadie. Aquí manda sobre `.env.local`: Next no pisa lo que ya viene en
        // el entorno.
        env: { NEXT_PUBLIC_SITE_URL: baseURL },
      },
});
