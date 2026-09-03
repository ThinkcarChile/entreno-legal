import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright corre SOLO contra staging. Sin `E2E_BASE_URL`, el contrato salta
 * cada spec con motivo y el informe queda en NOT_RUN. No hay proyecto "local":
 * la app habla PostgREST con Supabase y no existe un Supabase local acá.
 *
 * Tres anchos móviles (§31) y uno de escritorio (§32). `workers: 1` y sin
 * `fullyParallel` a propósito: todos los flujos comparten el hogar sintético de
 * A y B, y dos specs escribiendo la misma semana a la vez no prueban
 * concurrencia, prueban ruido. La concurrencia se prueba DENTRO de un spec
 * (§28), con dos pestañas del mismo usuario.
 *
 * `retries: 0`: un flaky es un defecto (de la app o del spec), no algo que se
 * reintenta hasta que pase.
 */
export default defineConfig({
  testDir: "./e2e/flujos",
  outputDir: "./e2e/salida",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: "e2e/informe", open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    locale: "es-CL",
    timezoneId: "America/Santiago",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "staging", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "movil-320", use: { ...devices["Pixel 5"], viewport: { width: 320, height: 640 } } },
    { name: "movil-375", use: { ...devices["iPhone 12"], viewport: { width: 375, height: 812 } } },
    { name: "movil-430", use: { ...devices["iPhone 14 Pro Max"], viewport: { width: 430, height: 932 } } },
  ],
});
