import { expect, test, type Page } from "@playwright/test";

import {
  adminClient,
  clientAccount,
  ensureFixtures,
  runTag,
  supabaseReady,
  workerAccount,
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

  async function signIn(page: Page, email: string, password: string): Promise<void> {
    await page.goto("/entrar");
    await page.getByLabel("Correo electrónico").fill(email);
    await page.getByLabel("Contraseña").fill(password);
    await page.getByRole("button", { name: "Entrar" }).click();
    // Se espera a que la cabecera muestre la sesión, no a un tiempo fijo.
    await expect(page.getByRole("link", { name: "Mensajes" })).toBeVisible();
  }

  test("1. el cliente entra a su cuenta", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);
    await expect(page).toHaveURL(/\/trabajos/);
  });

  test("2. el cliente publica un trabajo", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);
    await page.goto("/publicar");

    // Paso 1: categoría
    await page.getByRole("button", { name: /Lanzamientos y tiendas/ }).click();
    await page.getByRole("button", { name: "Continuar" }).click();

    // Paso 2: dónde
    await page.getByLabel("Región").selectOption("13");
    await page.getByLabel("Comuna").selectOption("13-providencia");
    await page.getByLabel("Dirección").fill("Av. Providencia 1234, local 5");
    await page.getByLabel("Nombre del lugar").fill("Tienda de prueba");
    await page.getByRole("button", { name: "Continuar" }).click();

    // Paso 3: cuándo
    const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await page.getByLabel("Fecha").fill(date);
    await page.getByLabel("Hora de inicio").fill("05:00");
    await page.getByRole("button", { name: "5 h", exact: true }).click();
    await page.getByRole("button", { name: "Continuar" }).click();

    // Paso 4: descripción
    await page.getByLabel("Título").fill(jobTitle);
    await page
      .getByLabel("Descripción")
      .fill(
        "Necesito que alguien tome lugar en la fila desde temprano y me avise cómo avanza durante la mañana.",
      );
    await page.getByRole("button", { name: "Continuar" }).click();

    // Paso 5: objetivo
    await page.getByRole("button", { name: /Quedar lo más adelante posible/ }).click();
    await page.getByRole("button", { name: "Continuar" }).click();

    // Paso 6: precio
    await page.getByLabel("Tu tarifa por hora").fill("10000");
    await page.getByRole("button", { name: "Continuar" }).click();

    // Paso 7: revisión y publicación
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
});
