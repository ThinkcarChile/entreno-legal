import { expect, test } from "@playwright/test";

/**
 * Comprobaciones que no necesitan Supabase.
 *
 * Existen para que la suite siempre tenga algo que ejecutar y se note si la
 * aplicación deja de levantar, aunque el proyecto Supabase no esté a mano.
 */
test.describe("páginas públicas", () => {
  test("la portada carga con el claim y los accesos principales", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { level: 1, name: /nosotros hacemos la fila/i }),
    ).toBeVisible();

    // Los dos caminos, el de quien contrata y el de quien trabaja, desde arriba.
    await expect(page.getByRole("link", { name: "Publicar un trabajo" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Quiero trabajar" }).first()).toBeVisible();

    // El buscador de la portada no necesita sesión.
    await expect(page.getByLabel("Comuna")).toBeVisible();
  });

  test("el buscador de la portada lleva al listado con los filtros puestos", async ({ page }) => {
    await page.goto("/");

    await page.getByLabel("Comuna").selectOption("13-providencia");
    await page.getByRole("button", { name: "Buscar" }).click();

    await expect(page).toHaveURL(/\/trabajos\?.*comuna=13-providencia/);
  });

  test("la ayuda no promete soporte permanente ni urgencias", async ({ page }) => {
    await page.goto("/ayuda");

    await expect(page.getByRole("heading", { level: 1, name: "Ayuda y contacto" })).toBeVisible();
    await expect(page.getByText(/no hay atención telefónica ni soporte las 24 horas/i)).toBeVisible();
    await expect(page.getByText(/no somos un servicio de emergencia/i)).toBeVisible();
  });

  test("el listado de trabajos responde y filtra por la URL", async ({ page }) => {
    await page.goto("/trabajos?region=13");
    await expect(page.getByRole("heading", { name: "Trabajos disponibles" })).toBeVisible();
  });

  test("una ruta privada manda a entrar y conserva el destino", async ({ page }) => {
    await page.goto("/mis-trabajos/publicados");
    await expect(page).toHaveURL(/\/entrar\?next=%2Fmis-trabajos%2Fpublicados/);
    await expect(page.getByRole("heading", { name: /entra a tu cuenta/i })).toBeVisible();
  });

  test("el asistente de publicación abre en el primer paso", async ({ page }) => {
    await page.goto("/publicar");
    await expect(page.getByRole("heading", { name: "Publicar un trabajo" })).toBeVisible();
    // El primer paso ofrece los dos grandes tipos de servicio.
    await expect(page.getByRole("button", { name: /Hacer una fila/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Trámite o gestión/ })).toBeVisible();
  });
});
