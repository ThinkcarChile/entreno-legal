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
      page.getByRole("heading", { name: /tu tiempo vale más que una fila/i }),
    ).toBeVisible();

    // Los dos accesos aparecen dos veces: en el hero y en la llamada final.
    await expect(page.getByRole("link", { name: "Necesito ayuda" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Quiero ganar dinero" }).first()).toBeVisible();
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
