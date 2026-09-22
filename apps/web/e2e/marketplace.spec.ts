import { expect, test, type Page } from "@playwright/test";

import {
  adminClient,
  clientAccount,
  ensureFixtures,
  runTag,
  supabaseReady,
  workerAccount,
  signIn,
} from "./fixtures";

/**
 * Recorrido completo contra Supabase real.
 *
 * Cubre lo mínimo que define la etapa: entrar como cliente, publicar, entrar
 * como trabajador, ofertar y aceptar. Las comprobaciones exhaustivas de RLS,
 * privacidad y concurrencia viven en `npm run verify:supabase`, que trabaja por
 * API y es mucho más rápido que un navegador.
 *
 * Sin credenciales, el bloque entero se omite indicando por qué.
 */
const skipReason = supabaseReady();

test.describe("marketplace de punta a punta", () => {
  test.skip(skipReason !== null, `Necesita un proyecto Supabase real: ${skipReason}`);
  test.describe.configure({ mode: "serial" });

  let jobTitle = "";
  let jobId = "";

  test.beforeAll(async () => {
    await ensureFixtures();
    jobTitle = `Fila para lanzamiento de zapatillas ${runTag}`;
  });

  test.afterAll(async () => {
    // Se retira el trabajo creado para no dejar ruido en el proyecto.
    if (!jobId) return;
    const admin = adminClient();
    await admin.from("jobs").update({ status: "CANCELLED" }).eq("id", jobId);
  });

  /**
   * Busca el trabajo recorriendo las pestañas de estado.
   *
   * No se fija la pestaña a mano porque el estado del trabajo cambia con el
   * recorrido, y porque las pestañas se abren en la primera que tenga algo: en
   * una cuenta de pruebas con historial, esa no es la del trabajo de hoy.
   */
  async function expectJobInSomeTab(page: Page, title: string): Promise<void> {
    const tabs = page.getByRole("tab");
    const total = await tabs.count();
    expect(total).toBeGreaterThan(0);

    for (let i = 0; i < total; i += 1) {
      await tabs.nth(i).click();
      if (await page.getByText(title).first().isVisible().catch(() => false)) return;
    }
    throw new Error(`"${title}" no aparece en ninguna de las ${total} pestañas`);
  }

  test("1. el cliente entra a su cuenta", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);
    await expect(page).toHaveURL(/\/trabajos/);
  });

  test("2. el cliente publica un trabajo", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);
    await page.goto("/publicar");

    // Pantalla 1 de 4: qué necesitas.
    await page.getByRole("button", { name: /Lanzamientos y tiendas/ }).click();
    await page.getByRole("button", { name: "Continuar" }).click();

    // Pantalla 2 de 4: dónde y cuándo, juntos.
    await page.getByLabel("Región").selectOption("13");
    await page.getByLabel("Comuna").selectOption("13-providencia");
    await page.getByLabel("Dirección").fill("Av. Providencia 1234, local 5");
    await page.getByLabel("Nombre del lugar").fill("Tienda de prueba");

    const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await page.getByLabel("Fecha").fill(date);
    await page.getByLabel("Hora de inicio").fill("05:00");
    // Cinco horas, de 05:00 a 10:00. No hay preajuste de 5 h —los botones van
    // 30 min, 1, 2, 4, 6, 8, 12 y 24 h—, así que va por el campo de minutos
    // exactos, que además conviene ejercitar.
    await page.getByLabel("O ingresa los minutos exactos").fill("300");
    await page.getByRole("button", { name: "Continuar" }).click();

    // Pantalla 3 de 4: descripción y objetivo.
    await page.getByLabel("Título").fill(jobTitle);
    await page
      .getByLabel("Descripción")
      .fill(
        "Necesito que alguien tome lugar en la fila desde temprano y me avise cómo avanza durante la mañana.",
      );
    await page.getByRole("button", { name: /Quedar lo más adelante posible/ }).click();
    await page.getByRole("button", { name: "Continuar" }).click();

    // Pantalla 4 de 4: precio y revisión, en la misma vista.
    await page.getByLabel("Tu tarifa por hora").fill("10000");
    await expect(page.getByText(jobTitle)).toBeVisible();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Publicar trabajo" }).click();

    await expect(page.getByRole("heading", { name: /tu trabajo está publicado/i })).toBeVisible();

    const admin = adminClient();
    const { data } = await admin.from("jobs").select("id,status").eq("title", jobTitle).maybeSingle();
    expect(data).not.toBeNull();
    expect((data as { status: string }).status).toBe("PUBLISHED");
    jobId = (data as { id: string }).id;
  });

  test("3. el trabajador entra y encuentra el trabajo", async ({ page }) => {
    await signIn(page, workerAccount!.email, workerAccount!.password);
    await page.goto(`/trabajos/${jobId}`);
    await expect(page.getByRole("heading", { name: jobTitle })).toBeVisible();
    // La dirección exacta no se muestra antes de la asignación.
    await expect(page.getByText(/La dirección exacta se comparte/)).toBeVisible();
    await expect(page.getByText("Av. Providencia 1234")).toHaveCount(0);
  });

  test("4. el trabajador envía una oferta", async ({ page }) => {
    await signIn(page, workerAccount!.email, workerAccount!.password);
    await page.goto(`/trabajos/${jobId}`);

    await page.getByLabel("Tu tarifa por hora").fill("9000");
    await page
      .getByLabel("Mensaje al cliente")
      .fill("Vivo cerca y llego media hora antes para asegurar buen lugar.");
    await page.getByRole("button", { name: /Enviar oferta/ }).click();

    await expect(page.getByRole("button", { name: /Actualizar mi oferta/ })).toBeVisible();

    const admin = adminClient();
    const { data } = await admin.from("job_offers").select("status,hourly_rate").eq("job_id", jobId).maybeSingle();
    expect((data as { status: string }).status).toBe("PENDING");
    expect(Number((data as { hourly_rate: number }).hourly_rate)).toBe(9000);
  });

  test("5. el cliente acepta la oferta y llega al pago", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);
    await page.goto(`/mis-trabajos/publicados/${jobId}`);

    await expect(page.getByRole("heading", { name: /Ofertas recibidas/ })).toBeVisible();
    await page.getByRole("button", { name: "Aceptar oferta" }).click();
    await page.getByRole("button", { name: /Confirmar y pagar/ }).click();

    // Aceptar lleva directo a la pantalla de Pago Protegido.
    await expect(page).toHaveURL(/\/pagar\//);
    await expect(page.getByRole("heading", { name: /Pago Protegido/ })).toBeVisible();
    await expect(page.getByText("Total a pagar")).toBeVisible();

    const admin = adminClient();
    const [job, offer, assignment] = await Promise.all([
      admin.from("jobs").select("status").eq("id", jobId).maybeSingle(),
      admin.from("job_offers").select("status").eq("job_id", jobId).maybeSingle(),
      admin.from("assignments").select("id").eq("job_id", jobId).maybeSingle(),
    ]);

    expect((job.data as { status: string }).status).toBe("OFFER_ACCEPTED");
    expect((offer.data as { status: string }).status).toBe("ACCEPTED");
    expect(assignment.data).not.toBeNull();
  });

  test("6. el cliente simula el pago y el trabajo queda habilitado", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);

    const admin = adminClient();
    const { data: assignment } = await admin
      .from("assignments")
      .select("id")
      .eq("job_id", jobId)
      .maybeSingle();

    await page.goto(`/pagar/${(assignment as { id: string }).id}`);
    await page.getByRole("button", { name: /Simular pago aprobado/ }).click();

    await expect(page.getByText(/Pago confirmado/)).toBeVisible();

    const { data: job } = await admin.from("jobs").select("status").eq("id", jobId).maybeSingle();
    expect(job).not.toBeNull();
    expect((job as { status: string }).status).toBe("PAID");
  });

  /**
   * Las dos listas de "mis trabajos", con contenido.
   *
   * Van al final porque necesitan un trabajo ya asignado. Existen porque el
   * recorrido a mano encontró que ambas fallaban en cuanto había algo que
   * mostrar —pasaban funciones de un componente de servidor a uno de cliente— y
   * ninguna prueba las visitaba: con la cuenta vacía se ve el estado vacío y no
   * se llega a renderizar la parte rota.
   */
  test("7. las dos listas de mis trabajos muestran el trabajo", async ({ page }) => {
    await signIn(page, workerAccount!.email, workerAccount!.password);
    await page.goto("/mis-trabajos");
    await expect(page.getByRole("heading", { name: "Mis trabajos" })).toBeVisible();
    await expectJobInSomeTab(page, jobTitle);

    await signIn(page, clientAccount!.email, clientAccount!.password);
    await page.goto("/mis-trabajos/publicados");
    await expectJobInSomeTab(page, jobTitle);
  });
});
