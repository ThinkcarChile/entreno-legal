import { defineConfig, devices } from "@playwright/test";

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
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";

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
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run start -- --port 3100",
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
