/**
 * Verificación de la política de cancelación y pago contra un proyecto
 * Supabase REAL, con el proveedor simulado RETARDADO.
 *
 *   npm run verify:payments
 *   RACE_REPS=10 npm run verify:payments
 *
 * Es la contraparte en el proyecto alojado de `supabase/tests/07_*`: los
 * mismos escenarios, pero con las piezas que usa la aplicación de verdad
 * (`DelayedMockPaymentProvider` y `applyProviderResult`) hablando con PostgREST
 * como lo hace la ruta `/pagos/retorno`. Las carreras son reales: dos
 * peticiones en vuelo a la vez, serializadas solo por los bloqueos de la base.
 * No hay ningún `sleep`: lo que sincroniza es la barrera del proveedor
 * (`settle`), que libera a todos los que esperaban en el mismo tick.
 *
 * Lo que tiene que cumplirse SIEMPRE, y se comprueba al final sobre todos los
 * trabajos creados por esta ejecución:
 *   · un pago tiene a lo sumo un efecto financiero (un evento aplicado por id);
 *   · un pago tiene a lo sumo un payout;
 *   · un trabajo cancelado nunca tiene payout;
 *   · una asignación cancelada nunca queda habilitada;
 *   · `payment_events` es solo de escritura para la aplicación.
 *
 * Necesita en .env.local las variables de Supabase y las cuentas E2E de
 * cliente, trabajador y tercero (las mismas que `verify:supabase`). La clave de
 * servicio se usa para lo que en la aplicación es del servidor: registrar el
 * identificador del proveedor y asentar su resultado.
 *
 * Sale con código distinto de cero si alguna comprobación falla.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { DelayedMockPaymentProvider } from "../src/lib/payments/delayed-mock-provider.ts";
import { applyProviderResult, type SettlementOutcome } from "../src/lib/payments/settle.ts";
import { loadEnvLocal } from "./env-local.ts";

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ entorno */

loadEnvLocal(resolve(here, ".."));

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const RACE_REPS = Math.max(1, Number(process.env.RACE_REPS ?? "5") || 5);

const missing: string[] = [];
if (!SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
if (!PUBLISHABLE_KEY) missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
if (!SECRET_KEY) missing.push("SUPABASE_SECRET_KEY");

interface Account {
  label: string;
  email: string;
  password: string;
}

function account(label: string, emailVar: string, passwordVar: string): Account {
  const email = process.env[emailVar] ?? "";
  const password = process.env[passwordVar] ?? "";
  if (!email) missing.push(emailVar);
  if (!password) missing.push(passwordVar);
  return { label, email, password };
}

const CLIENT = account("cliente", "E2E_CLIENT_EMAIL", "E2E_CLIENT_PASSWORD");
const WORKER = account("trabajador", "E2E_WORKER_EMAIL", "E2E_WORKER_PASSWORD");
const OUTSIDER = account("tercero", "E2E_OUTSIDER_EMAIL", "E2E_OUTSIDER_PASSWORD");

if (missing.length > 0) {
  console.error("\n✗ Faltan variables para ejecutar la verificación de pagos:\n");
  for (const name of [...new Set(missing)]) console.error(`   · ${name}`);
  console.error("\nVer docs/DESPLIEGUE-SUPABASE.md y .env.example.\n");
  process.exit(1);
}

/* ------------------------------------------------------- arnés de pruebas */

interface Result {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];
let counter = 0;

function nextId(): string {
  counter += 1;
  return `S${String(counter).padStart(2, "0")}`;
}

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const id = nextId();
  try {
    const detail = await fn();
    results.push({ id, name, ok: true, detail });
    console.log(`  ${id} OK   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ id, name, ok: false, detail });
    console.log(`  ${id} FALLO ${name} — ${detail}`);
  }
}

/**
 * Comprueba que algo PROHIBIDO falle, y que falle POR EL MOTIVO ESPERADO.
 * 42501 es «sin privilegio», 23514 es una guarda de la base (CHECK o
 * disparador que lanza check_violation), P0002 «no existe».
 */
async function mustFailWith(
  name: string,
  codes: readonly string[],
  fn: () => PromiseLike<{ error: { message: string; code?: string } | null }>,
): Promise<void> {
  const id = nextId();
  const { error } = await fn();
  if (!error) {
    results.push({ id, name, ok: false, detail: "la operación prohibida fue permitida" });
    console.log(`  ${id} FALLO ${name} — la operación prohibida fue PERMITIDA`);
    return;
  }
  if (!error.code || !codes.includes(error.code)) {
    const detail = `falló, pero por otro motivo (${error.code ?? "sin código"}: ${error.message})`;
    results.push({ id, name, ok: false, detail });
    console.log(`  ${id} FALLO ${name} — ${detail}`);
    return;
  }
  results.push({ id, name, ok: true, detail: error.code });
  console.log(`  ${id} OK   ${name} — bloqueado (${error.code})`);
}

function section(title: string): void {
  console.log(`\n── ${title}`);
}

function orThrow<T>(response: { data: T; error: { message: string } | null }): T {
  if (response.error) throw new Error(response.error.message);
  return response.data;
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------- clientes */

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface Session {
  client: SupabaseClient;
  userId: string;
  email: string;
}

async function ensureAccount(acc: Account): Promise<Session> {
  const client = anonClient();
  let signIn = await client.auth.signInWithPassword({ email: acc.email, password: acc.password });

  if (signIn.error) {
    const created = await admin.auth.admin.createUser({
      email: acc.email,
      password: acc.password,
      email_confirm: true,
    });
    if (created.error && !/already/i.test(created.error.message)) {
      throw new Error(`no se pudo crear la cuenta ${acc.label}: ${created.error.message}`);
    }
    signIn = await client.auth.signInWithPassword({ email: acc.email, password: acc.password });
  }

  if (signIn.error || !signIn.data.user) {
    throw new Error(`no se pudo iniciar sesión como ${acc.label}: ${signIn.error?.message}`);
  }
  return { client, userId: signIn.data.user.id, email: acc.email };
}

/* ----------------------------------------------------------- escenario */

const RUN = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const provider = new DelayedMockPaymentProvider();

/** Todos los trabajos creados por esta ejecución: sobre ellos van los invariantes. */
const createdJobs: string[] = [];

type PaymentSetup = "ninguno" | "sin_transaccion" | "en_vuelo";

interface Fixture {
  jobId: string;
  assignmentId: string;
  paymentId: string | null;
  token: string | null;
  amount: number;
}

interface Snapshot {
  job: string;
  assignment: string;
  payment: string | null;
  reviewReason: string | null;
  capturedAt: string | null;
  paidAt: string | null;
  payouts: number;
  events: number;
}

let client!: Session;
let worker!: Session;
let outsider!: Session;
let categoryId = "";

/**
 * Monta el mismo punto de partida que `pg_temp.montar_pago` en la prueba
 * local, pero por las vías de la aplicación: publicar, ofertar, aceptar,
 * iniciar el pago y, si toca, crearlo en el proveedor retardado y registrar el
 * identificador con la clave de servicio (lo que hace `startProtectedPaymentAction`).
 */
async function montar(tag: string, pago: PaymentSetup): Promise<Fixture> {
  const published = await client.client.rpc("publish_job", {
    p_payload: {
      categoryId,
      title: `Cancelación y pago ${tag} ${RUN}`,
      description:
        "Trabajo creado por la verificación automatizada de la política de cancelación y pago.",
      regionCode: "13",
      communeCode: "13-providencia",
      placeName: "Lugar de prueba",
      addressLine: "Av. Providencia 1234",
      startsAt: new Date(Date.now() + 3 * 86400000).toISOString(),
      estimatedDurationMinutes: 300,
      urgency: "NORMAL",
      objectiveType: "HOLD_PLACE",
      hourlyRate: "10000",
    },
  });
  if (published.error) throw new Error(`publish_job: ${published.error.message}`);
  const jobId = String(published.data);
  createdJobs.push(jobId);

  const offer = orThrow(
    await worker.client
      .from("job_offers")
      .insert({ job_id: jobId, worker_id: worker.userId, hourly_rate: 9000, estimated_total: 45000 })
      .select("id")
      .single(),
  ) as { id: string };

  const accepted = await client.client.rpc("accept_job_offer", { p_offer_id: offer.id });
  if (accepted.error) throw new Error(`accept_job_offer: ${accepted.error.message}`);
  const assignmentId = String(accepted.data);

  if (pago === "ninguno") return { jobId, assignmentId, paymentId: null, token: null, amount: 0 };

  const started = await client.client.rpc("start_protected_payment", { p_assignment_id: assignmentId });
  if (started.error) throw new Error(`start_protected_payment: ${started.error.message}`);
  const paymentId = String(started.data);

  const payment = orThrow(
    await admin.from("payments").select("amount,status").eq("id", paymentId).single(),
  ) as { amount: number; status: string };
  expect(payment.status === "PENDING", `el pago recién iniciado está ${payment.status}`);

  if (pago === "sin_transaccion") {
    return { jobId, assignmentId, paymentId, token: null, amount: payment.amount };
  }

  const created = await provider.createPayment({
    paymentId,
    jobId,
    reference: tag,
    amount: { amount: payment.amount, currency: "CLP" },
    returnUrl: "http://localhost/pagos/retorno",
    sessionId: client.userId.slice(0, 26),
  });
  orThrow(
    await admin
      .from("payments")
      .update({
        status: created.status,
        provider: provider.id,
        provider_transaction_id: created.providerTransactionId,
        provider_token: created.token,
      })
      .eq("id", paymentId)
      .select("id"),
  );

  return { jobId, assignmentId, paymentId, token: created.token, amount: payment.amount };
}

async function snapshot(f: Fixture): Promise<Snapshot> {
  const [job, assignment, payment, payouts, events] = await Promise.all([
    admin.from("jobs").select("status").eq("id", f.jobId).single(),
    admin.from("assignments").select("status").eq("id", f.assignmentId).single(),
    f.paymentId
      ? admin
          .from("payments")
          .select("status,review_reason,captured_at,paid_at")
          .eq("id", f.paymentId)
          .single()
      : Promise.resolve({ data: null, error: null }),
    admin.from("payouts").select("id", { count: "exact", head: true }).eq("assignment_id", f.assignmentId),
    f.paymentId
      ? admin
          .from("payment_events")
          .select("id", { count: "exact", head: true })
          .eq("payment_id", f.paymentId)
          .not("provider_event_id", "is", null)
      : Promise.resolve({ count: 0, error: null }),
  ]);
  for (const r of [job, assignment, payment, payouts, events]) {
    if (r.error) throw new Error(r.error.message);
  }
  const p = payment.data as {
    status: string;
    review_reason: string | null;
    captured_at: string | null;
    paid_at: string | null;
  } | null;
  return {
    job: (job.data as { status: string }).status,
    assignment: (assignment.data as { status: string }).status,
    payment: p?.status ?? null,
    reviewReason: p?.review_reason ?? null,
    capturedAt: p?.captured_at ?? null,
    paidAt: p?.paid_at ?? null,
    payouts: payouts.count ?? 0,
    events: events.count ?? 0,
  };
}

function describe(s: Snapshot): string {
  const pago = s.payment ? `${s.payment}${s.reviewReason ? ` (${s.reviewReason})` : ""}` : "sin pago";
  return `trabajo ${s.job}, asignación ${s.assignment}, pago ${pago}, payouts ${s.payouts}, eventos ${s.events}`;
}

/** Lo que hace la ruta de retorno: esperar al proveedor y asentar su respuesta. */
async function confirmAndApply(f: Fixture): Promise<SettlementOutcome> {
  if (!f.paymentId || !f.token) throw new Error("el escenario no tiene pago en vuelo");
  const result = await provider.confirmPayment({ token: f.token });
  return applyProviderResult(admin, f.paymentId, provider.id, result);
}

function cancel(f: Fixture, who: Session, reason: string | null = null) {
  return who.client.rpc("cancel_job", { p_job_id: f.jobId, p_reason: reason });
}

function isCheckViolation(error: { code?: string } | null): boolean {
  return error?.code === "23514";
}

/* ----------------------------------------------------------------- flujo */

async function main(): Promise<void> {
  console.log(`\nVerificación de cancelación y pago contra Supabase real`);
  console.log(`Proyecto: ${new URL(SUPABASE_URL).hostname}`);
  console.log(`Proveedor: ${provider.id} · Repeticiones de carrera: ${RACE_REPS}`);
  console.log(`Ejecución: ${RUN}\n`);

  section("Cuentas y punto de partida");

  client = await ensureAccount(CLIENT);
  worker = await ensureAccount(WORKER);
  outsider = await ensureAccount(OUTSIDER);

  await check("cliente y trabajador quedan listos para operar", async () => {
    const onboardClient = await client.client.rpc("complete_onboarding", {
      p_first_name: "Paula",
      p_last_name: "Control",
      p_phone: "+56911110001",
      p_region_code: "13",
      p_commune_code: "13-providencia",
      p_avatar_url: null,
      p_wants_client: true,
      p_wants_worker: false,
    });
    if (onboardClient.error) throw new Error(onboardClient.error.message);

    const onboardWorker = await worker.client.rpc("complete_onboarding", {
      p_first_name: "Andrés",
      p_last_name: "Control",
      p_phone: "+56911110002",
      p_region_code: "13",
      p_commune_code: "13-santiago",
      p_avatar_url: null,
      p_wants_client: false,
      p_wants_worker: true,
    });
    if (onboardWorker.error) throw new Error(onboardWorker.error.message);

    // La verificación es decisión de administración; aquí se deja hecha.
    orThrow(
      await admin
        .from("worker_profiles")
        .update({ verification_status: "VERIFIED", identity_verified: true, is_accepting_jobs: true })
        .eq("user_id", worker.userId)
        .select("user_id"),
    );

    const category = orThrow(
      await admin.from("job_categories").select("id").eq("slug", "filas-lanzamientos-tiendas").maybeSingle(),
    ) as { id: string } | null;
    expect(Boolean(category), "falta la categoría de prueba: aplica la semilla");
    categoryId = category!.id;

    const { data: fn, error } = await admin.rpc("confirm_payment_result", {
      p_payment_id: "00000000-0000-0000-0000-000000000000",
      p_provider: provider.id,
      p_provider_event_id: "sonda",
      p_result: "FAILED",
      p_amount: null,
      p_details: {},
    });
    // Debe existir y contestar «no existe el pago», no «no existe la función».
    expect(error?.code === "P0002", `confirm_payment_result no responde como se esperaba: ${error?.code ?? fn}`);
    return "cuentas, verificación y migración de pagos presentes";
  });

  section("Política de cancelación, escenario por escenario");

  await check("cancelar sin pago iniciado es inmediato", async () => {
    const f = await montar("s-sin-pago", "ninguno");
    orThrow(await cancel(f, client, "Ya no lo necesito"));
    const s = await snapshot(f);
    expect(s.job === "CANCELLED" && s.assignment === "CANCELLED_BY_CLIENT", describe(s));
    const pending = orThrow(
      await admin.from("job_offers").select("id").eq("job_id", f.jobId).eq("status", "PENDING"),
    ) as { id: string }[];
    expect(pending.length === 0, "quedaron ofertas pendientes");
    return describe(s);
  });

  await check("cancelar con un pago que nunca llegó al proveedor lo deja FAILED y cancela", async () => {
    const f = await montar("s-sin-transaccion", "sin_transaccion");
    orThrow(await cancel(f, client));
    const s = await snapshot(f);
    expect(s.job === "CANCELLED" && s.payment === "FAILED" && s.payouts === 0, describe(s));
    return describe(s);
  });

  await check("cancelar con un pago en vuelo queda EN VERIFICACIÓN y no cancela todavía", async () => {
    const f = await montar("s-en-vuelo", "en_vuelo");
    orThrow(await cancel(f, client, "Cambio de planes"));
    const s = await snapshot(f);
    expect(
      s.job === "CANCELLATION_PENDING" && s.assignment === "AWAITING_PAYMENT" && s.payment === "CREATED",
      describe(s),
    );
    expect(provider.isPending(f.token!), "el proveedor ya no tenía el pago en vuelo");
    const second = await cancel(f, client, "otra vez");
    expect(isCheckViolation(second.error), `una segunda cancelación debió rechazarse: ${second.error?.code}`);
    // Se cierra el escenario: el proveedor rechaza y la cancelación se completa.
    provider.settle(f.token!, "FAILED");
    const outcome = await confirmAndApply(f);
    const after = await snapshot(f);
    expect(outcome.paymentStatus === "FAILED" && after.job === "CANCELLED", describe(after));
    return `${describe(s)} → tras el rechazo: ${describe(after)}`;
  });

  await check("aprobado ANTES de cancelar: se habilita, hay payout, y ya no cabe cancelar", async () => {
    const f = await montar("s-aprobado-antes", "en_vuelo");
    provider.settle(f.token!, "PAID");
    const outcome = await confirmAndApply(f);
    const s = await snapshot(f);
    expect(outcome.outcome === "applied" && outcome.payoutId !== null, "no se aplicó o no hubo payout");
    expect(s.job === "PAID" && s.assignment === "CONFIRMED" && s.payouts === 1, describe(s));
    const late = await cancel(f, client, "tarde");
    expect(
      isCheckViolation(late.error) && /reembolso o una disputa/.test(late.error?.message ?? ""),
      `la cancelación debió derivar a reembolso o disputa: ${late.error?.message}`,
    );
    return describe(s);
  });

  await check("cancelación pedida y DESPUÉS llega la aprobación: dinero registrado, sin payout, cancelado", async () => {
    const f = await montar("s-aprobacion-tardia", "en_vuelo");
    // La confirmación ya está esperando al proveedor cuando el cliente cancela.
    const confirmation = confirmAndApply(f);
    orThrow(await cancel(f, client, "Me arrepentí"));
    const mid = await snapshot(f);
    expect(mid.job === "CANCELLATION_PENDING", `antes de la respuesta: ${describe(mid)}`);
    provider.settle(f.token!, "PAID");
    const outcome = await confirmation;
    const s = await snapshot(f);
    expect(outcome.outcome === "applied" && outcome.payoutId === null, "hubo payout o no se aplicó");
    expect(
      s.payment === "UNDER_REVIEW" &&
        s.reviewReason === "late_confirmation_after_cancellation" &&
        s.capturedAt !== null &&
        s.paidAt === null &&
        s.job === "CANCELLED" &&
        s.assignment === "CANCELLED_BY_CLIENT" &&
        s.payouts === 0 &&
        s.events === 1,
      describe(s),
    );
    return describe(s);
  });

  await check("cancelación pedida y llega un RECHAZO: se completa sin dinero de por medio", async () => {
    const f = await montar("s-rechazo-tardio", "en_vuelo");
    const confirmation = confirmAndApply(f);
    orThrow(await cancel(f, client));
    provider.settle(f.token!, "FAILED");
    await confirmation;
    const s = await snapshot(f);
    expect(
      s.payment === "FAILED" && s.job === "CANCELLED" && s.assignment === "CANCELLED_BY_CLIENT" && s.payouts === 0,
      describe(s),
    );

    // Y una aprobación contradictoria sobre ese mismo pago, ya cancelado: en
    // revisión, sin habilitar nada.
    const contradictory = await applyProviderResult(admin, f.paymentId!, provider.id, {
      providerTransactionId: f.token!,
      providerEventId: `evt-${f.token}-contradictorio`,
      status: "PAID",
      amount: { amount: f.amount, currency: "CLP" },
      authorizationCode: "X",
      cardLastDigits: null,
      paymentTypeCode: null,
      installments: null,
      transactionDate: new Date().toISOString(),
      raw: { mock: true },
    });
    const after = await snapshot(f);
    expect(
      contradictory.outcome === "applied" &&
        after.payment === "UNDER_REVIEW" &&
        after.reviewReason === "approved_after_failed" &&
        after.job === "CANCELLED" &&
        after.payouts === 0,
      `aprobación posterior: ${describe(after)}`,
    );
    return `${describe(s)}; aprobación posterior → ${after.payment} (${after.reviewReason})`;
  });

  await check("la misma confirmación dos veces, en secuencia: la segunda es un duplicado", async () => {
    const f = await montar("s-duplicado", "en_vuelo");
    provider.settle(f.token!, "PAID");
    const first = await confirmAndApply(f);
    const second = await confirmAndApply(f);
    const s = await snapshot(f);
    expect(first.outcome === "applied" && second.outcome === "duplicate", `${first.outcome} / ${second.outcome}`);
    expect(s.events === 1 && s.payouts === 1 && s.payment === "PAID", describe(s));
    expect(provider.confirmationsOf(f.token!) === 2, "el proveedor no vio dos confirmaciones");
    return `primera ${first.outcome}, segunda ${second.outcome}; ${describe(s)}`;
  });

  await check("el proveedor confirma otro importe: revisión por discrepancia, nada se habilita", async () => {
    const f = await montar("s-importe", "en_vuelo");
    provider.settle(f.token!, "PAID");
    const result = await provider.confirmPayment({ token: f.token! });
    const outcome = await applyProviderResult(admin, f.paymentId!, provider.id, {
      ...result,
      amount: { amount: 1, currency: "CLP" },
    });
    const s = await snapshot(f);
    expect(
      outcome.paymentStatus === "UNDER_REVIEW" &&
        s.reviewReason === "amount_mismatch" &&
        s.job === "PAYMENT_PENDING" &&
        s.payouts === 0,
      describe(s),
    );
    return describe(s);
  });

  section("Carreras reales, repetidas");

  await check(`dos confirmaciones SIMULTÁNEAS del mismo evento, ${RACE_REPS} veces`, async () => {
    for (let i = 1; i <= RACE_REPS; i += 1) {
      const f = await montar(`s-carrera-dup-${i}`, "en_vuelo");
      // Las dos quedan esperando al proveedor; `settle` las suelta en el mismo tick.
      const a = confirmAndApply(f);
      const b = confirmAndApply(f);
      provider.settle(f.token!, "PAID");
      const [ra, rb] = await Promise.all([a, b]);
      const outcomes = [ra.outcome, rb.outcome].sort();
      const s = await snapshot(f);
      expect(
        outcomes[0] === "applied" && outcomes[1] === "duplicate",
        `repetición ${i}: resultados ${outcomes.join(" y ")}`,
      );
      expect(
        s.events === 1 && s.payouts === 1 && s.payment === "PAID" && s.job === "PAID",
        `repetición ${i}: ${describe(s)}`,
      );
    }
    return `${RACE_REPS} veces: 1 aplicada, 1 duplicada, 1 evento, 1 payout`;
  });

  await check(`aprobación y cancelación SIMULTÁNEAS, ${RACE_REPS} veces, nunca las dos`, async () => {
    let wonPayment = 0;
    let wonCancel = 0;
    for (let i = 1; i <= RACE_REPS; i += 1) {
      const f = await montar(`s-carrera-cancel-${i}`, "en_vuelo");
      const confirmation = confirmAndApply(f);
      const cancellation = cancel(f, client, "carrera");
      provider.settle(f.token!, "PAID");
      const [outcome, cancelled] = await Promise.all([confirmation, cancellation]);
      const s = await snapshot(f);

      const paymentWon =
        s.job === "PAID" &&
        s.assignment === "CONFIRMED" &&
        s.payment === "PAID" &&
        s.payouts === 1 &&
        outcome.payoutId !== null &&
        isCheckViolation(cancelled.error) &&
        /reembolso o una disputa/.test(cancelled.error?.message ?? "");
      const cancelWon =
        s.job === "CANCELLED" &&
        s.assignment === "CANCELLED_BY_CLIENT" &&
        s.payment === "UNDER_REVIEW" &&
        s.reviewReason === "late_confirmation_after_cancellation" &&
        s.payouts === 0 &&
        outcome.payoutId === null &&
        !cancelled.error;

      expect(
        paymentWon !== cancelWon,
        `repetición ${i}: estado incoherente: ${describe(s)}; cancelación: ${cancelled.error?.message ?? "ok"}`,
      );
      if (paymentWon) wonPayment += 1;
      else wonCancel += 1;
    }
    return `ganó el pago ${wonPayment}, ganó la cancelación ${wonCancel}; nunca las dos`;
  });

  section("Lo que nadie puede hacer a mano");

  {
    const f = await montar("s-manual", "en_vuelo");

    await mustFailWith("ni el sistema crea un payout sobre un pago sin confirmar", ["23514"], () =>
      admin.from("payouts").insert({
        assignment_id: f.assignmentId,
        worker_id: worker.userId,
        gross_amount: f.amount,
        net_amount: f.amount,
      }),
    );

    await mustFailWith("un usuario con sesión no tiene privilegio para crear payouts", ["42501"], () =>
      worker.client.from("payouts").insert({
        assignment_id: f.assignmentId,
        worker_id: worker.userId,
        gross_amount: f.amount,
        net_amount: f.amount,
      }),
    );

    await mustFailWith("un tercero no cancela un trabajo ajeno", ["42501"], () => cancel(f, outsider, "ajeno"));

    await mustFailWith("un usuario con sesión no puede ejecutar la confirmación del proveedor", ["42501"], () =>
      client.client.rpc("confirm_payment_result", {
        p_payment_id: f.paymentId,
        p_provider: provider.id,
        p_provider_event_id: "evt-usuario",
        p_result: "PAID",
        p_amount: f.amount,
        p_details: {},
      }),
    );

    await mustFailWith("el cliente no puede reescribir su pago", ["42501"], () =>
      client.client.from("payments").update({ amount: 1, status: "PAID" }).eq("id", f.paymentId!),
    );

    await mustFailWith("un evento inventado para otro proveedor se rechaza", ["23514"], () =>
      admin.rpc("confirm_payment_result", {
        p_payment_id: f.paymentId,
        p_provider: "otro-proveedor",
        p_provider_event_id: "evt-otro",
        p_result: "PAID",
        p_amount: f.amount,
        p_details: {},
      }),
    );

    // Se cancela y el proveedor rechaza: la asignación queda cancelada.
    orThrow(await cancel(f, client));
    provider.settle(f.token!, "FAILED");
    await confirmAndApply(f);

    await mustFailWith("ni el sistema crea un payout sobre una asignación cancelada", ["23514"], () =>
      admin.from("payouts").insert({
        assignment_id: f.assignmentId,
        worker_id: worker.userId,
        gross_amount: f.amount,
        net_amount: f.amount,
      }),
    );

    await mustFailWith("ni el sistema habilita una asignación cancelada", ["23514"], () =>
      admin.from("assignments").update({ status: "CONFIRMED" }).eq("id", f.assignmentId),
    );

    await mustFailWith("ni el sistema revive un trabajo cancelado", ["23514"], () =>
      admin.from("jobs").update({ status: "PAYMENT_PENDING" }).eq("id", f.jobId),
    );

    await mustFailWith("la bitácora de pagos no se edita desde una sesión", ["42501"], () =>
      client.client.from("payment_events").update({ payload: {} }).eq("payment_id", f.paymentId!),
    );

    await mustFailWith("la bitácora de pagos no se borra desde una sesión", ["42501"], () =>
      client.client.from("payment_events").delete().eq("payment_id", f.paymentId!),
    );
  }

  section("Invariantes sobre todo lo creado en esta ejecución");

  await check("ningún invariante financiero está roto", async () => {
    const [jobs, assignments, payments, payouts, events] = await Promise.all([
      admin.from("jobs").select("id,status").in("id", createdJobs),
      admin.from("assignments").select("id,job_id,status,worker_id").in("job_id", createdJobs),
      admin.from("payments").select("id,job_id,assignment_id,status,captured_at").in("job_id", createdJobs),
      admin
        .from("payouts")
        .select("id,assignment_id,payment_id,worker_id")
        .in(
          "assignment_id",
          (orThrow(await admin.from("assignments").select("id").in("job_id", createdJobs)) as { id: string }[]).map(
            (a) => a.id,
          ),
        ),
      admin
        .from("payment_events")
        .select("id,payment_id,provider,provider_event_id,to_status")
        .in(
          "payment_id",
          (orThrow(await admin.from("payments").select("id").in("job_id", createdJobs)) as { id: string }[]).map(
            (p) => p.id,
          ),
        ),
    ]);
    for (const r of [jobs, assignments, payments, payouts, events]) if (r.error) throw new Error(r.error.message);

    const jobById = new Map((jobs.data as { id: string; status: string }[]).map((j) => [j.id, j]));
    const asgById = new Map(
      (assignments.data as { id: string; job_id: string; status: string; worker_id: string }[]).map((a) => [a.id, a]),
    );
    const payById = new Map(
      (payments.data as { id: string; job_id: string; assignment_id: string; status: string }[]).map((p) => [p.id, p]),
    );
    const violations: string[] = [];
    const deadJob = new Set(["CANCELLED", "CANCELLATION_PENDING", "EXPIRED"]);
    const deadAssignment = new Set(["CANCELLED_BY_CLIENT", "CANCELLED_BY_WORKER"]);

    const perPayment = new Map<string, number>();
    const perAssignment = new Map<string, number>();
    for (const p of payouts.data as { id: string; assignment_id: string; payment_id: string | null; worker_id: string }[]) {
      const a = asgById.get(p.assignment_id);
      const j = a ? jobById.get(a.job_id) : undefined;
      if (!a || !j) violations.push(`payout ${p.id} sin asignación o trabajo`);
      else {
        if (deadAssignment.has(a.status) || deadJob.has(j.status)) violations.push(`payout ${p.id} sobre cancelado`);
        if (a.worker_id !== p.worker_id) violations.push(`payout ${p.id} a otro trabajador`);
      }
      const pay = p.payment_id ? payById.get(p.payment_id) : undefined;
      if (!pay || pay.status !== "PAID") violations.push(`payout ${p.id} sin pago PAID`);
      if (pay && pay.assignment_id !== p.assignment_id) violations.push(`payout ${p.id} con pago de otra asignación`);
      perPayment.set(p.payment_id ?? "-", (perPayment.get(p.payment_id ?? "-") ?? 0) + 1);
      perAssignment.set(p.assignment_id, (perAssignment.get(p.assignment_id) ?? 0) + 1);
    }
    for (const [id, n] of perPayment) if (n > 1) violations.push(`pago ${id} con ${n} payouts`);
    for (const [id, n] of perAssignment) if (n > 1) violations.push(`asignación ${id} con ${n} payouts`);

    for (const a of asgById.values()) {
      const j = jobById.get(a.job_id)!;
      if (deadJob.has(j.status) && a.status !== "AWAITING_PAYMENT" && !deadAssignment.has(a.status)) {
        violations.push(`asignación ${a.id} ${a.status} sobre trabajo ${j.status}`);
      }
    }
    for (const p of payById.values()) {
      const j = jobById.get(p.job_id)!;
      if (p.status === "PAID" && deadJob.has(j.status)) violations.push(`pago ${p.id} PAID sobre trabajo ${j.status}`);
    }
    for (const j of jobById.values()) {
      if (j.status === "PAID") {
        const paid = [...payById.values()].some((p) => p.job_id === j.id && p.status === "PAID");
        if (!paid) violations.push(`trabajo ${j.id} PAID sin pago PAID`);
      }
    }
    const seen = new Set<string>();
    for (const e of events.data as { id: string; provider: string; provider_event_id: string | null }[]) {
      if (!e.provider_event_id) continue;
      const key = `${e.provider}/${e.provider_event_id}`;
      if (seen.has(key)) violations.push(`evento ${key} registrado dos veces`);
      seen.add(key);
    }

    expect(violations.length === 0, violations.join("; "));
    return `${jobById.size} trabajos, ${payById.size} pagos, ${(payouts.data ?? []).length} payouts, ${(events.data ?? []).length} eventos: cero violaciones`;
  });

  /* ---------------------------------------------------------------- informe */

  const failed = results.filter((r) => !r.ok);
  console.log("\n══════════════════════════════════════════════════════════");
  console.log(`  ${results.length - failed.length} de ${results.length} comprobaciones pasaron`);
  if (failed.length > 0) {
    console.log("\n  Fallaron:");
    for (const r of failed) console.log(`   · ${r.id} ${r.name}: ${r.detail}`);
  }
  console.log("══════════════════════════════════════════════════════════\n");

  await Promise.all([client, worker, outsider].map((s) => s.client.auth.signOut()));
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("\n✗ La verificación de pagos se interrumpió:", error instanceof Error ? error.message : error);
  process.exit(1);
});
