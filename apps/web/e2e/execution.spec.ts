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
 * Ejecución del trabajo, por navegador.
 *
 * Lo que aquí se prueba y en `verify:execution` no: que la interfaz ofrece la
 * acción correcta en cada momento y ninguna más. Las reglas ya están cubiertas
 * por API; esto comprueba que la pantalla las respeta —que el trabajador no ve
 * el botón de aprobar, que el cliente no ve el de check-in, que el código de
 * entrega solo aparece cuando se pide— y que el recorrido completo se puede
 * hacer con el ratón.
 *
 * El montaje hasta «pagado» se hace por API a propósito: ya está probado paso a
 * paso en `marketplace.spec.ts`, y repetirlo por pantalla solo haría la prueba
 * más lenta y más frágil.
 */
const skipReason = supabaseReady();

test.describe("ejecución del trabajo", () => {
  test.skip(skipReason !== null, `Necesita un proyecto Supabase real: ${skipReason}`);
  test.describe.configure({ mode: "serial" });

  // Providencia: es donde el montaje sitúa el trabajo, así que el check-in del
  // navegador cae dentro del radio y queda verificado.
  const LAT = -33.4265;
  const LNG = -70.6153;

  let jobId = "";
  let assignmentId = "";
  let jobTitle = "";
  let clientId = "";
  let workerId = "";

  test.use({ geolocation: { latitude: LAT, longitude: LNG }, permissions: ["geolocation"] });

  test.beforeAll(async () => {
    const ids = await ensureFixtures();
    clientId = ids.clientId;
    workerId = ids.workerId;
    jobTitle = `Ejecución en navegador ${runTag}`;

    const admin = adminClient();

    const { data: category } = await admin
      .from("job_categories")
      .select("id")
      .eq("slug", "filas-lanzamientos-tiendas")
      .maybeSingle();

    // Trabajo publicado, con su dirección exacta: el check-in se mide contra ella.
    const { data: job, error: jobError } = await admin
      .from("jobs")
      .insert({
        client_id: clientId,
        category_id: (category as { id: string }).id,
        status: "PUBLISHED",
        title: jobTitle,
        description: "Trabajo creado por la prueba de navegador de la ejecución completa.",
        region_code: "13",
        commune_code: "13-providencia",
        place_name: "Lugar de prueba",
        starts_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
        estimated_duration_minutes: 120,
        objective_type: "HOLD_PLACE",
        hourly_rate: 9000,
        published_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (jobError) throw new Error(jobError.message);
    jobId = (job as { id: string }).id;

    await admin.from("job_private_location").insert({
      job_id: jobId,
      address_line: "Av. Providencia 1234",
      lat: LAT,
      lng: LNG,
    });

    const { data: offer } = await admin
      .from("job_offers")
      .insert({
        job_id: jobId,
        worker_id: workerId,
        hourly_rate: 9000,
        estimated_total: 18000,
        message: "Oferta de la prueba de navegador",
      })
      .select("id")
      .single();

    // `accept_job_offer` es del cliente y solo del cliente, así que la
    // asignación se monta con la clave de servicio: montar el escenario no es
    // lo que esta prueba verifica.
    const { data: created, error: assignmentError } = await admin
      .from("assignments")
      .insert({
        job_id: jobId,
        offer_id: (offer as { id: string }).id,
        worker_id: workerId,
        client_id: clientId,
        status: "AWAITING_PAYMENT",
        agreed_hourly_rate: 9000,
        agreed_duration_minutes: 120,
        agreed_total: 18000,
      })
      .select("id")
      .single();
    if (assignmentError) throw new Error(assignmentError.message);
    assignmentId = (created as { id: string }).id;

    await admin
      .from("job_offers")
      .update({ status: "ACCEPTED" })
      .eq("id", (offer as { id: string }).id);
    await admin.from("jobs").update({ status: "OFFER_ACCEPTED" }).eq("id", jobId);

    const { data: payment, error: paymentError } = await admin
      .from("payments")
      .insert({
        job_id: jobId,
        assignment_id: assignmentId,
        client_id: clientId,
        purpose: "JOB",
        status: "CREATED",
        amount: 18000,
        provider: "mock",
        provider_transaction_id: `e2e-${runTag}-${Date.now()}`,
      })
      .select("id,provider_transaction_id")
      .single();
    if (paymentError) throw new Error(paymentError.message);

    const { error: confirmError } = await admin.rpc("confirm_payment_result", {
      p_payment_id: (payment as { id: string }).id,
      p_provider: "mock",
      p_provider_event_id: `evt-${(payment as { provider_transaction_id: string }).provider_transaction_id}`,
      p_result: "PAID",
      p_amount: null,
      p_details: {},
    });
    if (confirmError) throw new Error(confirmError.message);
  });

  test.afterAll(async () => {
    if (!jobId) return;
    const admin = adminClient();
    await admin.from("jobs").update({ status: "CLOSED" }).eq("id", jobId);
  });

  async function signIn(page: Page, email: string, password: string): Promise<void> {
    await page.goto("/entrar");
    await page.getByLabel("Correo electrónico").fill(email);
    await page.getByLabel("Contraseña").fill(password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("link", { name: "Mensajes" })).toBeVisible();
  }

  test("1. el trabajador avisa que va en camino y hace check-in", async ({ page }) => {
    await signIn(page, workerAccount!.email, workerAccount!.password);
    await page.goto(`/mis-trabajos/${assignmentId}`);

    // Solo se ofrece el paso que toca: no hay botón de aprobar ni de pagar.
    await expect(page.getByRole("button", { name: "Voy en camino" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Aprobar el trabajo/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Voy en camino" }).click();

    const checkIn = page.getByRole("button", { name: "Llegué al lugar" });
    await expect(checkIn).toBeVisible();
    // El consentimiento se dice antes de pedir la ubicación.
    await expect(page.getByText(/Usaremos tu ubicación únicamente/)).toBeVisible();

    await checkIn.click();
    await expect(page.getByText(/Llegada verificada/)).toBeVisible({ timeout: 20_000 });

    const admin = adminClient();
    const { data } = await admin
      .from("assignment_check_ins")
      .select("result")
      .eq("assignment_id", assignmentId)
      .maybeSingle();
    expect((data as { result: string }).result).toBe("VERIFIED");
  });

  test("2. comienza el trabajo y publica una actualización", async ({ page }) => {
    await signIn(page, workerAccount!.email, workerAccount!.password);
    await page.goto(`/mis-trabajos/${assignmentId}`);

    await page.getByRole("button", { name: "Comenzar el trabajo" }).click();
    // El contador aparece en cuanto el trabajo está en curso.
    await expect(page.getByText("Tiempo transcurrido")).toBeVisible();

    await page.getByLabel("Qué está pasando").fill("Ya estoy en la fila");
    await page.getByLabel("Detalle").fill("Hay unas treinta personas por delante.");
    await page.getByRole("button", { name: "Publicar actualización" }).click();

    await expect(page.getByText("La actualización quedó publicada.")).toBeVisible();
    await expect(page.getByText("Ya estoy en la fila").first()).toBeVisible();
  });

  test("3. el cliente ve el avance y no ve el botón de check-in", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);
    await page.goto(`/mis-trabajos/${assignmentId}`);

    await expect(page.getByText("Ya estoy en la fila").first()).toBeVisible();
    await expect(page.getByText(/Llegada al lugar registrada/)).toBeVisible();

    // Acciones que no son suyas.
    await expect(page.getByRole("button", { name: "Llegué al lugar" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Voy en camino" })).toHaveCount(0);

    // Y en la línea de tiempo no hay coordenadas.
    await expect(page.getByText(/-33\.4|-70\.6/)).toHaveCount(0);
  });

  test("4. el código de entrega solo aparece cuando el cliente lo pide", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);
    await page.goto(`/mis-trabajos/${assignmentId}`);

    await expect(page.getByText(/El código aparece solo cuando lo pides/)).toBeVisible();
    await page.getByRole("button", { name: "Ver el código de entrega" }).click();
    await expect(page.getByLabel("Código de entrega")).toBeVisible();

    const admin = adminClient();
    const { data } = await admin
      .from("handoff_codes")
      .select("code")
      .eq("assignment_id", assignmentId)
      .maybeSingle();
    const code = (data as { code: string }).code;

    // El trabajador lo escribe y con eso queda la entrega.
    await signIn(page, workerAccount!.email, workerAccount!.password);
    await page.goto(`/mis-trabajos/${assignmentId}`);
    await page.getByLabel("Código de entrega de cuatro dígitos").fill(code);
    await page.getByRole("button", { name: "Confirmar entrega" }).click();

    await expect(page.getByText(/Entrega completada/).first()).toBeVisible({ timeout: 20_000 });
  });

  test("5. el cliente aprueba y con eso se libera el pago", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);
    await page.goto(`/mis-trabajos/${assignmentId}`);

    await page.getByRole("button", { name: "Aprobar el trabajo" }).click();
    await page.getByRole("button", { name: /Sí, aprobar y liberar el pago/ }).click();

    await expect(page.getByText("¿Cómo fue tu experiencia?")).toBeVisible({ timeout: 20_000 });

    const admin = adminClient();
    const { data: payout } = await admin
      .from("payouts")
      .select("status")
      .eq("assignment_id", assignmentId)
      .maybeSingle();
    expect((payout as { status: string }).status).toBe("APPROVED");
  });

  test("6. el trabajador ve la ganancia en su panel", async ({ page }) => {
    await signIn(page, workerAccount!.email, workerAccount!.password);
    await page.goto("/mis-trabajos/ganancias");

    await expect(page.getByRole("heading", { name: "Mis ganancias" })).toBeVisible();
    await expect(page.getByText(jobTitle)).toBeVisible();
    // No se afirma ninguna transferencia que no haya ocurrido.
    await expect(page.getByText(/La transferencia la registra una persona del equipo/)).toBeVisible();
  });
});
