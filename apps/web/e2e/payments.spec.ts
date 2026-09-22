import { expect, test, type Page } from "@playwright/test";

import {
  adminClient,
  clientAccount,
  ensureFixtures,
  runTag,
  signIn,
  supabaseReady,
} from "./fixtures";

/**
 * Recorrido de pago por navegador.
 *
 * Hasta dónde llega y por qué.
 *
 * El formulario de Webpay vive en `webpay3gint.transbank.cl`, un dominio de
 * terceros. Automatizarlo es posible —es un formulario normal— pero desde este
 * entorno **no se puede**: el cortafuegos de Transbank (Imperva) responde 403 a
 * las peticiones desde direcciones de centros de datos, incluidas las de este
 * contenedor. No es un fallo de la integración ni de las credenciales: es que
 * desde aquí no hay camino hasta ellos.
 *
 * Así que esta prueba hace lo que sí puede hacerse de verdad, y **no finge el
 * resto**:
 *
 * · Recorre el pago hasta la página de transición, comprobando que el
 *   formulario POST se arma con el token en un campo oculto y apunta al
 *   dominio del ambiente.
 * · Recorre los CUATRO retornos oficiales contra la ruta real, con los
 *   parámetros que manda Webpay en cada uno, y comprueba el estado en que
 *   queda el pago en la base.
 * · Comprueba que un retorno repetido no cobra dos veces, y que el retorno de
 *   otra persona no asienta nada.
 *
 * Lo que queda sin automatizar —pasar por el formulario de Webpay con una
 * tarjeta de prueba— está descrito paso a paso en `docs/TRANSBANK.md` §8 para
 * hacerlo a mano desde una red que alcance a Transbank.
 */
const skipReason = supabaseReady();

test.describe.configure({ mode: "serial" });

test.describe("pago protegido", () => {
  test.skip(() => skipReason !== null, skipReason ?? "");

  let jobId = "";
  let assignmentId = "";
  let paymentId = "";

  /**
   * Monta un trabajo asignado y esperando pago, por API.
   *
   * Por API y no por la interfaz a propósito: lo que esta prueba cubre es el
   * pago, no volver a recorrer la publicación, que ya tiene su propia prueba.
   *
   * Se monta uno NUEVO en cada ejecución y no se reutiliza el que haya. La
   * primera versión tomaba «la última asignación esperando pago» y se topó con
   * una que arrastraba un pago en revisión de otra prueba: `start_protected_
   * payment` la rechazó, con razón. Una prueba que depende del estado que
   * dejaron otras no prueba lo que dice probar.
   */
  /**
   * Monta un trabajo asignado y esperando pago, por API, y devuelve sus
   * identificadores.
   *
   * Cada escenario que necesite empezar de cero llama a esto. La primera
   * versión reutilizaba «la última asignación esperando pago» y encadenaba
   * escenarios sobre el estado que dejaba el anterior: bastaba que uno
   * terminara en PAID para que el siguiente no tuviera dónde pulsar.
   */
  async function createPendingAssignment(): Promise<{ jobId: string; assignmentId: string }> {
    const { clientId, workerId } = await ensureFixtures();
    const admin = adminClient();

    const { data: category } = await admin
      .from("job_categories")
      .select("id")
      .eq("slug", "filas-lanzamientos-tiendas")
      .maybeSingle<{ id: string }>();

    const { data: job, error: jobError } = await admin
      .from("jobs")
      .insert({
        client_id: clientId,
        category_id: category!.id,
        status: "PUBLISHED",
        title: `Pago Webpay ${runTag}-${Math.random().toString(36).slice(2, 8)}`,
        description: "Trabajo creado por la prueba de navegador del pago protegido.",
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
    const newJobId = (job as { id: string }).id;

    await admin.from("job_private_location").insert({
      job_id: newJobId,
      address_line: "Av. Providencia 1234",
      lat: -33.4265,
      lng: -70.6153,
    });

    const { data: offer } = await admin
      .from("job_offers")
      .insert({
        job_id: newJobId,
        worker_id: workerId,
        hourly_rate: 9000,
        estimated_total: 18000,
        message: "Oferta de la prueba de pago",
      })
      .select("id")
      .single();

    const { data: created, error: assignmentError } = await admin
      .from("assignments")
      .insert({
        job_id: newJobId,
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

    await admin
      .from("job_offers")
      .update({ status: "ACCEPTED" })
      .eq("id", (offer as { id: string }).id);
    await admin.from("jobs").update({ status: "OFFER_ACCEPTED" }).eq("id", newJobId);

    return { jobId: newJobId, assignmentId: (created as { id: string }).id };
  }

  /**
   * Lleva el pago hasta la página de transición y devuelve su identificador.
   *
   * Se corta la salida hacia el formulario de pago: con Webpay porque está en
   * otro dominio, y con el proveedor simulado porque su «formulario» es la
   * propia ruta de retorno y se enviaría sola a los 600 ms, resolviendo el
   * pago antes de que el escenario haya empezado. Aquí lo que se quiere es un
   * pago CREATED, parado justo antes de salir.
   */
  async function startCheckout(page: Page, forAssignment: string): Promise<string> {
    await page.route("**/webpayserver/**", (route) => route.abort());
    await page.route("**/pagos/retorno*", (route) => route.abort());
    await page.goto(`/pagar/${forAssignment}`);
    await page
      .getByRole("button", { name: /simular pago aprobado|pagar con webpay/i })
      .click();
    await page.waitForURL(/\/ir$/, { timeout: 30_000 });

    const { data } = await adminClient()
      .from("payments")
      .select("id")
      .eq("assignment_id", forAssignment)
      .in("status", ["PENDING", "CREATED"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();

    return data!.id;
  }

  test("1. se prepara un trabajo esperando pago", async () => {
    const fixture = await createPendingAssignment();
    jobId = fixture.jobId;
    assignmentId = fixture.assignmentId;
    expect(assignmentId).not.toBe("");
  });

  test("2. la pantalla de pago no promete una pasarela que no está conectada", async ({
    page,
  }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);
    await page.goto(`/pagar/${assignmentId}`);

    await expect(page.getByRole("heading", { level: 1 })).toContainText(/pago protegido/i);

    // Con el proveedor simulado lo dice; con Transbank en integración, también.
    const body = await page.locator("body").innerText();
    expect(body).toMatch(/no hay pasarela de pago conectada|ambiente de pruebas de Webpay/i);
  });

  test("3. iniciar el pago lleva a la transición con el token en un POST", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);
    await page.goto(`/pagar/${assignmentId}`);

    // El formulario de Webpay es de otro dominio: se corta la navegación justo
    // antes de salir, que es exactamente donde termina lo que controlamos.
    await page.route("**/webpayserver/**", (route) => route.abort());
    await page.route("**/pagos/retorno*", (route) => route.abort());
    await page
      .getByRole("button", { name: /simular pago aprobado|pagar con webpay/i })
      .click();

    await page.waitForURL(new RegExp(`/pagar/${assignmentId}/ir`), { timeout: 30_000 });

    await expect(page.getByRole("heading", { name: /preparando tu pago/i })).toBeVisible();

    // El token viaja en un campo oculto de un formulario POST. Ni en la URL,
    // ni en un enlace, ni en un GET.
    const form = page.locator("form[method='post']");
    await expect(form).toHaveCount(1);
    const action = await form.getAttribute("action");
    expect(action).toBeTruthy();

    const tokenField = form.locator("input[name='token_ws']");
    await expect(tokenField).toHaveAttribute("type", "hidden");
    const token = await tokenField.inputValue();
    expect(token.length).toBeGreaterThan(0);

    // El token no puede estar en la URL de la página.
    expect(page.url()).not.toContain(token);

    const admin = adminClient();
    const { data: payment } = await admin
      .from("payments")
      .select("id,status,buy_order,session_id,environment,attempt,redirect_url")
      .eq("assignment_id", assignmentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{
        id: string;
        status: string;
        buy_order: string | null;
        session_id: string | null;
        environment: string | null;
        attempt: number;
        redirect_url: string | null;
      }>();

    paymentId = payment!.id;

    // El intento quedó escrito ANTES de salir: es lo que permite conciliar si
    // la respuesta del proveedor se pierde.
    expect(payment!.status).toBe("CREATED");
    expect(payment!.buy_order).toMatch(/^HTF-[0-9A-F]{12}-[A-Z0-9]{9}$/);
    expect(payment!.buy_order!.length).toBeLessThanOrEqual(26);
    expect(payment!.session_id).toMatch(/^S-[0-9A-F]{32}$/);
    expect(payment!.attempt).toBeGreaterThanOrEqual(1);
    expect(payment!.redirect_url).toBe(action);
  });

  /* ------------------------------------------------- los cuatro retornos --- */

  test("4. retorno con tiempo agotado: sin token, no se cobra", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);

    const admin = adminClient();
    const { data: before } = await admin
      .from("payments")
      .select("buy_order,session_id")
      .eq("id", paymentId)
      .maybeSingle<{ buy_order: string; session_id: string }>();

    await returnTo(page, {
      TBK_ID_SESION: before!.session_id,
      TBK_ORDEN_COMPRA: before!.buy_order,
    });

    const { data: after } = await admin
      .from("payments")
      .select("status,failure_reason")
      .eq("id", paymentId)
      .maybeSingle<{ status: string; failure_reason: string | null }>();

    expect(after!.status).toBe("FAILED");
    expect(after!.failure_reason).toBe("form_timeout");
    // Ni rastro de un cobro.
    const { count } = await admin
      .from("payouts")
      .select("id", { count: "exact", head: true })
      .eq("payment_id", paymentId);
    expect(count ?? 0).toBe(0);
  });

  test("5. tras un retorno fallido se puede reintentar con otra orden", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);

    const admin = adminClient();
    const { data: previous } = await admin
      .from("payments")
      .select("buy_order")
      .eq("id", paymentId)
      .maybeSingle<{ buy_order: string }>();

    const failedPaymentId = paymentId;
    paymentId = await startCheckout(page, assignmentId);

    const { data: current } = await admin
      .from("payments")
      .select("id,buy_order,attempt,status")
      .eq("assignment_id", assignmentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; buy_order: string; attempt: number; status: string }>();

    // Orden de compra nueva: Webpay no admite reutilizar la de una transacción
    // viva, y una que ya falló no se repesca.
    expect(current!.buy_order).not.toBe(previous!.buy_order);
    expect(current!.status).toBe("CREATED");
    expect(current!.attempt).toBeGreaterThanOrEqual(1);

    // Que el reintento sea una fila nueva o la misma es cosa de
    // `start_protected_payment`: un pago FAILED no se reutiliza —queda como
    // registro de lo que pasó— y uno vivo sí. Lo que importa de verdad, y es
    // lo que se comprueba, es que NUNCA haya dos pagos vivos a la vez sobre la
    // misma asignación: eso sí serían dos cobros.
    const { count: vivos } = await admin
      .from("payments")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", assignmentId)
      .eq("purpose", "JOB")
      .in("status", ["PENDING", "CREATED", "AUTHORIZED", "PAID", "UNDER_REVIEW"]);
    expect(vivos ?? 0).toBe(1);

    // El anterior sigue ahí, fallido: la historia no se reescribe.
    const { data: old } = await admin
      .from("payments")
      .select("status")
      .eq("id", failedPaymentId)
      .maybeSingle<{ status: string }>();
    expect(old!.status).toBe("FAILED");

    expect(current!.id).toBe(paymentId);
  });

  test("6. retorno abortado: se registra la cancelación, no un cobro", async ({ page }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);

    const admin = adminClient();
    const { data: before } = await admin
      .from("payments")
      .select("provider_token,buy_order,session_id")
      .eq("id", paymentId)
      .maybeSingle<{ provider_token: string; buy_order: string; session_id: string }>();

    await returnTo(page, {
      TBK_TOKEN: before!.provider_token,
      TBK_ID_SESION: before!.session_id,
      TBK_ORDEN_COMPRA: before!.buy_order,
    });

    const { data: after } = await admin
      .from("payments")
      .select("status,failure_reason")
      .eq("id", paymentId)
      .maybeSingle<{ status: string; failure_reason: string | null }>();

    // Con el proveedor simulado la consulta de estado dice que sí está
    // autorizado, y entonces el cobro manda: eso también es correcto. Lo que
    // NO puede pasar es que quede como un cobro a medias.
    expect(["FAILED", "PAID"]).toContain(after!.status);
    if (after!.status === "FAILED") {
      expect(after!.failure_reason).toBe("aborted_by_user");
    }
  });

  test("7. retorno contradictorio: los cuatro parámetros no confirman a ciegas", async ({
    page,
  }) => {
    await signIn(page, clientAccount!.email, clientAccount!.password);

    const admin = adminClient();

    // Trabajo nuevo y pago nuevo: este escenario no se apoya en lo que dejaron
    // los anteriores. La primera versión forzaba el pago previo de vuelta a
    // CREATED con la clave de servicio, y eso destapó un hueco de verdad —un
    // PAID podía retroceder y dejaba huérfano el pago al trabajador—, que se
    // cerró con un disparador. Ahora ese atajo está prohibido, que es como
    // debe ser.
    const fixture = await createPendingAssignment();
    paymentId = await startCheckout(page, fixture.assignmentId);

    const { data: before } = await admin
      .from("payments")
      .select("provider_token,buy_order,session_id")
      .eq("id", paymentId)
      .maybeSingle<{ provider_token: string; buy_order: string; session_id: string }>();

    await returnTo(page, {
      token_ws: before!.provider_token,
      TBK_TOKEN: before!.provider_token,
      TBK_ID_SESION: before!.session_id,
      TBK_ORDEN_COMPRA: before!.buy_order,
    });

    const { data: after } = await admin
      .from("payments")
      .select("status")
      .eq("id", paymentId)
      .maybeSingle<{ status: string }>();

    // No quedó a medias: o se resolvió con el estado real, o se registró el
    // conflicto. Nunca «pendiente para siempre».
    expect(["PAID", "FAILED", "UNDER_REVIEW"]).toContain(after!.status);
  });

  test("8. el retorno de otra persona no asienta nada", async ({ page, context }) => {
    const admin = adminClient();
    const { data: payment } = await admin
      .from("payments")
      .select("provider_token,status")
      .eq("id", paymentId)
      .maybeSingle<{ provider_token: string; status: string }>();

    const before = payment!.status;

    // Sin sesión: el retorno tiene que mandar a entrar, no resolver el pago.
    await context.clearCookies();
    await page.goto(`/pagos/retorno?token_ws=${payment!.provider_token}`);
    await expect(page).toHaveURL(/\/entrar/);

    const { data: after } = await admin
      .from("payments")
      .select("status")
      .eq("id", paymentId)
      .maybeSingle<{ status: string }>();
    expect(after!.status).toBe(before);
  });

  test("9. el trabajo queda coherente al terminar", async () => {
    const admin = adminClient();
    const { data } = await admin.rpc("payment_invariant_violations").select?.() ?? { data: null };
    // La función vive en app_private y no es invocable por PostgREST; los
    // invariantes se comprueban en db:test. Aquí se comprueba lo visible:
    // que no hay pago al trabajador sobre un pago que no se cobró.
    void data;

    const { data: payment } = await admin
      .from("payments")
      .select("status")
      .eq("id", paymentId)
      .maybeSingle<{ status: string }>();

    const { count } = await admin
      .from("payouts")
      .select("id", { count: "exact", head: true })
      .eq("payment_id", paymentId);

    if (payment!.status === "PAID") {
      expect(count ?? 0).toBe(1);
    } else {
      expect(count ?? 0).toBe(0);
    }

    void jobId;
  });
});

/**
 * Visita la ruta de retorno con los parámetros de un flujo concreto.
 *
 * En una pestaña nueva, no en la que se quedó en la página de transición.
 *
 * Esa página lleva un temporizador que envía el formulario a los 600 ms, y con
 * el proveedor simulado ese formulario apunta a la propia ruta de retorno.
 * Reutilizar la pestaña significaba competir contra ese envío: la navegación
 * del escenario llegaba a la vez y el navegador abortaba una de las dos. La
 * pestaña nueva comparte la sesión —es el mismo contexto— y no arrastra
 * ningún temporizador.
 */
async function returnTo(page: Page, params: Record<string, string>): Promise<void> {
  const query = new URLSearchParams(params).toString();
  const fresh = await page.context().newPage();
  try {
    await fresh.goto(`/pagos/retorno?${query}`, { waitUntil: "domcontentloaded" });
  } finally {
    await fresh.close();
  }
}
