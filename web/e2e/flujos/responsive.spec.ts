/**
 * E2E §31-§32 — MÓVIL Y ESCRITORIO: los flujos críticos (entrar, semana,
 * compras, cocina) caben en 320/375/430 sin desborde horizontal, y en 1280 el
 * layout USA el ancho: barra lateral y lienzo lado a lado.
 *
 * Lo que este archivo afirma del producto (`components/AppShell.tsx`):
 *  · En móvil: barra superior + bottom nav de CINCO destinos (Pendientes,
 *    Semana, Cocina, Compras, Salud) y sin barra lateral. El "Asistente" vive
 *    solo en la lateral: su ausencia en móvil es la prueba de qué barra se ve.
 *  · En escritorio: barra lateral fija de 16 rem con TODOS los destinos, sin
 *    bottom nav, y el lienzo ocupa el resto.
 *  · Nunca `scrollWidth > clientWidth` en el documento: una página que se
 *    desborda a lo ancho se usa con el pulgar corriendo el contenido, y en la
 *    cocina eso es una lista que no se lee.
 *
 * El proyecto de Playwright decide el ancho (playwright.config.ts). Cada
 * describe se salta en los proyectos que no le corresponden, con motivo.
 */
import type { Page } from "@playwright/test";
import { test, expect, iniciarSesion } from "../fixtures/contrato";

/** Ancho de la barra lateral: `w-64` = 16 rem = 256 px a 16 px de base. */
const ANCHO_LATERAL = 256;
const DESTINOS_BOTTOM = ["Pendientes", "Semana", "Cocina", "Compras", "Salud"] as const;

async function desborde(page: Page): Promise<{ scroll: number; visible: number }> {
  return page.evaluate(() => ({
    scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    visible: document.documentElement.clientWidth,
  }));
}

/** Falla con las dos cifras a la vista: "se desbordó" sin números no se puede arreglar. */
async function sinDesbordeHorizontal(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  const { scroll, visible } = await desborde(page);
  expect(scroll, `scrollWidth ${scroll} > clientWidth ${visible} en ${page.url()}`).toBeLessThanOrEqual(
    visible,
  );
}

function esEscritorio(): boolean {
  return test.info().project.name === "staging";
}

const FLUJOS: readonly { nombre: string; ruta: string; titulo: string | RegExp }[] = [
  { nombre: "semana", ruta: "/plan", titulo: "Semana" },
  { nombre: "compras", ruta: "/shopping", titulo: /^Compra de la semana$|^Compras$/ },
  { nombre: "cocina", ruta: "/prep", titulo: "Preparación" },
  { nombre: "pendientes", ruta: "/inbox", titulo: "Pendientes" },
];

test.describe("§31 — móvil (320 / 375 / 430): sin desborde horizontal, con bottom nav", () => {
  test.beforeEach(() => {
    test.skip(esEscritorio(), "Este describe es de los proyectos movil-*.");
  });

  test("entrar: el login cabe y deja a la persona dentro", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "NutriFamilia" })).toBeVisible();
    await sinDesbordeHorizontal(page);
    // El login se prueba POR LA INTERFAZ a este ancho, no inyectando cookies.
    await iniciarSesion(page, "A");
    await sinDesbordeHorizontal(page);
  });

  for (const flujo of FLUJOS) {
    test(`${flujo.nombre}: ${flujo.ruta} cabe en el ancho`, async ({ comoA: page }) => {
      await page.goto(flujo.ruta);
      await expect(page.getByRole("heading", { name: flujo.titulo })).toBeVisible();
      await sinDesbordeHorizontal(page);

      // La navegación del pulgar: cinco destinos, todos visibles, y ninguno
      // de la barra lateral (que en móvil no existe).
      for (const destino of DESTINOS_BOTTOM) {
        await expect(page.getByRole("link", { name: destino, exact: true })).toBeVisible();
      }
      await expect(page.getByRole("link", { name: "Asistente", exact: true })).toHaveCount(0);
    });
  }

  test("semana: cambiar de semana no desborda", async ({ comoA: page }) => {
    await page.goto("/plan");
    await page.getByRole("link", { name: "Semana siguiente" }).click();
    await expect(page.getByRole("link", { name: "Volver a esta semana" })).toBeVisible();
    await sinDesbordeHorizontal(page);
  });

  test("compras: cambiar de semana no desborda", async ({ comoA: page }) => {
    await page.goto("/shopping");
    await page.getByRole("link", { name: "Siguiente" }).click();
    await expect(page.getByRole("link", { name: "Volver a esta semana" })).toBeVisible();
    await sinDesbordeHorizontal(page);
  });

  test("cocina: los equipos caben", async ({ comoA: page }) => {
    await page.goto("/prep");
    await page.getByRole("link", { name: "Equipos" }).click();
    await expect(page).toHaveURL(/\/prep\/equipment/);
    await sinDesbordeHorizontal(page);
  });

  test("asistente: el chat cabe y el composer se puede usar con una mano", async ({ comoA: page }) => {
    await page.goto("/asistente");
    await sinDesbordeHorizontal(page);
    const composer = page.getByLabel("Pregúntame algo de la casa");
    await expect(composer).toBeVisible();
    // Área de toque mínima de 44 px (el kit lo promete con `min-h-[44px]`).
    const caja = await composer.boundingBox();
    if (caja === null) throw new Error("el composer no tiene caja");
    expect(caja.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("§32 — escritorio (1280): barra lateral y lienzo lado a lado, sin bottom nav", () => {
  test.beforeEach(() => {
    test.skip(!esEscritorio(), "Este describe es del proyecto staging (1280).");
  });

  for (const flujo of FLUJOS) {
    test(`${flujo.nombre}: ${flujo.ruta} usa el ancho`, async ({ comoA: page }) => {
      await page.goto(flujo.ruta);
      await expect(page.getByRole("heading", { name: flujo.titulo })).toBeVisible();
      await sinDesbordeHorizontal(page);

      // La lateral es la que trae "Asistente"; el bottom nav no existe acá, así
      // que cada destino aparece UNA vez.
      const lateral = page.getByRole("navigation").filter({
        has: page.getByRole("link", { name: "Asistente", exact: true }),
      });
      await expect(lateral).toHaveCount(1);
      for (const destino of DESTINOS_BOTTOM) {
        await expect(page.getByRole("link", { name: destino, exact: true })).toHaveCount(1);
      }

      // Dos columnas de verdad: la lateral pegada a la izquierda, el lienzo a
      // su derecha, y el lienzo con el resto del ancho.
      const cajaLateral = await lateral.boundingBox();
      const cajaLienzo = await page.getByRole("main").boundingBox();
      if (cajaLateral === null || cajaLienzo === null) throw new Error("lateral o lienzo sin caja");
      expect(cajaLateral.x).toBe(0);
      expect(Math.round(cajaLateral.width)).toBe(ANCHO_LATERAL);
      expect(cajaLienzo.x).toBeGreaterThanOrEqual(cajaLateral.x + cajaLateral.width);
      expect(cajaLienzo.width).toBeGreaterThanOrEqual(1280 - ANCHO_LATERAL - 1);
    });
  }

  test("entrar: el login cabe centrado en 1280", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "NutriFamilia" })).toBeVisible();
    await sinDesbordeHorizontal(page);
    await iniciarSesion(page, "A");
    await sinDesbordeHorizontal(page);
  });
});
