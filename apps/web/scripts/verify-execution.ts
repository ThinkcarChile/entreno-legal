/**
 * Verificación de la ejecución del trabajo contra un proyecto Supabase REAL.
 *
 *   npm run verify:execution
 *   RACE_REPS=10 npm run verify:execution
 *
 * Es la contraparte alojada de `supabase/tests/08_*`: el mismo recorrido —ir en
 * camino, llegar, comenzar, informar con evidencia, pedir más tiempo, entregar
 * con código, cerrar, aprobar, reseñar, disputar, pagar— pero por HTTP, con la
 * sesión de cada persona y con la RLS del proyecto real decidiendo.
 *
 * Lo que aquí se puede probar y en SQL no: que la separación de sesiones
 * funciona de verdad. En una prueba de psql «ser el cliente» es una variable de
 * sesión; aquí es un token firmado, y si una política deja pasar a quien no
 * debe, se ve.
 *
 * Las carreras son reales: dos peticiones simultáneas a PostgREST, serializadas
 * solo por el bloqueo de fila que toman las funciones. Sin `sleep`.
 *
 * Necesita en .env.local las variables de Supabase y las cuentas E2E de cliente,
 * trabajador, tercero y administración.
 *
 * Sale con código distinto de cero si alguna comprobación falla.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
const ADMIN = account("administración", "E2E_ADMIN_EMAIL", "E2E_ADMIN_PASSWORD");

if (missing.length > 0) {
  console.error("\n✗ Faltan variables para verificar la ejecución del trabajo:\n");
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
  return `W${String(counter).padStart(2, "0")}`;
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

/* ----------------------------------------------------------------- montaje */

const RUN = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

/** Coordenadas del lugar de los trabajos de prueba: Providencia, Santiago. */
const LAT = -33.4265;
const LNG = -70.6153;

let client!: Session;
let worker!: Session;
let outsider!: Session;
let adminUser!: Session;
let categoryId = "";

const createdJobs: string[] = [];

interface Fixture {
  jobId: string;
  assignmentId: string;
  paymentId: string;
}

/**
 * Un trabajo pagado y listo para comenzar, montado por el camino real:
 * publicar, ofertar, aceptar, pagar y confirmar.
 */
async function montar(tag: string): Promise<Fixture> {
  const published = await client.client.rpc("publish_job", {
    p_payload: {
      categoryId,
      title: `Ejecución ${tag} ${RUN}`,
      description: "Trabajo creado por la verificación automatizada de la ejecución completa.",
      regionCode: "13",
      communeCode: "13-providencia",
      placeName: "Lugar de prueba",
      addressLine: "Av. Providencia 1234",
      lat: LAT,
      lng: LNG,
      startsAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
      estimatedDurationMinutes: 120,
      urgency: "NORMAL",
      objectiveType: "HOLD_PLACE",
      hourlyRate: "9000",
      bonusAmount: "3000",
      bonusConditions: "Si el objetivo se cumple.",
    },
  });
  if (published.error) throw new Error(`publish_job: ${published.error.message}`);
  const jobId = String(published.data);
  createdJobs.push(jobId);

  const offer = orThrow(
    await worker.client
      .from("job_offers")
      .insert({ job_id: jobId, worker_id: worker.userId, hourly_rate: 9000, estimated_total: 18000 })
      .select("id")
      .single(),
  ) as { id: string };

  const accepted = await client.client.rpc("accept_job_offer", { p_offer_id: offer.id });
  if (accepted.error) throw new Error(`accept_job_offer: ${accepted.error.message}`);
  const assignmentId = String(accepted.data);

  const started = await client.client.rpc("start_protected_payment", {
    p_assignment_id: assignmentId,
  });
  if (started.error) throw new Error(`start_protected_payment: ${started.error.message}`);
  const paymentId = String(started.data);

  // Lo que hace la ruta de retorno con el proveedor simulado inmediato.
  const token = `mock-${tag}-${Math.random().toString(36).slice(2, 8)}`;
  orThrow(
    await admin
      .from("payments")
      .update({ status: "CREATED", provider: "mock", provider_transaction_id: token })
      .eq("id", paymentId)
      .select("id"),
  );
  const confirmed = await admin.rpc("confirm_payment_result", {
    p_payment_id: paymentId,
    p_provider: "mock",
    p_provider_event_id: `evt-${token}`,
    p_result: "PAID",
    p_amount: null,
    p_details: {},
  });
  if (confirmed.error) throw new Error(`confirm_payment_result: ${confirmed.error.message}`);

  return { jobId, assignmentId, paymentId };
}

/** El recorrido del trabajador hasta el trabajo en curso. */
async function hastaEnCurso(f: Fixture): Promise<void> {
  const a = await worker.client.rpc("mark_on_the_way", { p_assignment_id: f.assignmentId });
  if (a.error) throw new Error(`mark_on_the_way: ${a.error.message}`);
  const b = await worker.client.rpc("register_check_in", {
    p_assignment_id: f.assignmentId,
    p_consent: true,
    p_lat: LAT,
    p_lng: LNG,
    p_accuracy_m: 15,
    p_source: "device",
  });
  if (b.error) throw new Error(`register_check_in: ${b.error.message}`);
  const c = await worker.client.rpc("start_job_work", { p_assignment_id: f.assignmentId });
  if (c.error) throw new Error(`start_job_work: ${c.error.message}`);
}

async function assignmentStatus(id: string): Promise<string> {
  const row = orThrow(
    await admin.from("assignments").select("status").eq("id", id).single(),
  ) as { status: string };
  return row.status;
}

/* ----------------------------------------------------------------- flujo */

async function main(): Promise<void> {
  console.log(`\nVerificación de la ejecución del trabajo contra Supabase real`);
  console.log(`Proyecto: ${new URL(SUPABASE_URL).hostname}`);
  console.log(`Repeticiones de carrera: ${RACE_REPS}`);
  console.log(`Ejecución: ${RUN}\n`);

  section("Cuentas y punto de partida");

  client = await ensureAccount(CLIENT);
  worker = await ensureAccount(WORKER);
  outsider = await ensureAccount(OUTSIDER);
  adminUser = await ensureAccount(ADMIN);

  await check("cuentas listas y trabajador verificado", async () => {
    for (const [session, data] of [
      [
        client,
        {
          p_first_name: "Paula",
          p_last_name: "Control",
          p_phone: "+56911110001",
          p_region_code: "13",
          p_commune_code: "13-providencia",
          p_avatar_url: null,
          p_wants_client: true,
          p_wants_worker: false,
        },
      ],
      [
        worker,
        {
          p_first_name: "Andrés",
          p_last_name: "Control",
          p_phone: "+56911110002",
          p_region_code: "13",
          p_commune_code: "13-santiago",
          p_avatar_url: null,
          p_wants_client: false,
          p_wants_worker: true,
        },
      ],
    ] as const) {
      const { error } = await session.client.rpc("complete_onboarding", data);
      if (error) throw new Error(error.message);
    }

    orThrow(
      await admin
        .from("worker_profiles")
        .update({ verification_status: "VERIFIED", identity_verified: true, is_accepting_jobs: true })
        .eq("user_id", worker.userId)
        .select("user_id"),
    );
    orThrow(
      await admin.from("profiles").update({ role: "ADMIN" }).eq("id", adminUser.userId).select("id"),
    );

    const category = orThrow(
      await admin
        .from("job_categories")
        .select("id")
        .eq("slug", "filas-lanzamientos-tiendas")
        .maybeSingle(),
    ) as { id: string } | null;
    expect(Boolean(category), "falta la categoría de prueba: aplica la semilla");
    categoryId = category!.id;
    return "cliente, trabajador verificado, tercero y administración";
  });

  section("Recorrido completo");

  await check("del pago confirmado a la aprobación del cliente", async () => {
    const f = await montar("w-feliz");

    const onTheWay = await worker.client.rpc("mark_on_the_way", {
      p_assignment_id: f.assignmentId,
    });
    if (onTheWay.error) throw new Error(`en camino: ${onTheWay.error.message}`);

    const checkIn = await worker.client.rpc("register_check_in", {
      p_assignment_id: f.assignmentId,
      p_consent: true,
      p_lat: LAT,
      p_lng: LNG,
      p_accuracy_m: 12,
      p_source: "device",
    });
    if (checkIn.error) throw new Error(`check-in: ${checkIn.error.message}`);
    const checkInRow = checkIn.data as Record<string, unknown>;
    expect(checkInRow.result === "VERIFIED", `check-in ${checkInRow.result}`);

    const start = await worker.client.rpc("start_job_work", { p_assignment_id: f.assignmentId });
    if (start.error) throw new Error(`inicio: ${start.error.message}`);

    const evidence = await worker.client.rpc("add_job_evidence", {
      p_assignment_id: f.assignmentId,
      p_evidence_type: "QUEUE_STATUS",
      p_title: "Voy avanzando",
      p_body: "Quedan pocas personas por delante.",
      p_storage_path: null,
      p_mime_type: null,
      p_size_bytes: null,
      p_queue_ahead: 4,
    });
    if (evidence.error) throw new Error(`evidencia: ${evidence.error.message}`);

    const code = await client.client.rpc("generate_handoff_code", {
      p_assignment_id: f.assignmentId,
    });
    if (code.error) throw new Error(`código: ${code.error.message}`);

    const verified = await worker.client.rpc("verify_handoff_code", {
      p_assignment_id: f.assignmentId,
      p_code: String(code.data),
    });
    if (verified.error) throw new Error(`validación: ${verified.error.message}`);
    expect(verified.data === true, "el código correcto no validó");

    const approved = await client.client.rpc("approve_job_completion", {
      p_assignment_id: f.assignmentId,
      p_bonus_awarded: true,
    });
    if (approved.error) throw new Error(`aprobación: ${approved.error.message}`);

    const payout = orThrow(
      await admin
        .from("payouts")
        .select("status,net_amount")
        .eq("assignment_id", f.assignmentId)
        .single(),
    ) as { status: string; net_amount: number };

    const status = await assignmentStatus(f.assignmentId);
    expect(status === "COMPLETED", `asignación ${status}`);
    expect(payout.status === "APPROVED", `payout ${payout.status}`);
    expect(payout.net_amount === 18000 - Math.round(18000 * 0.14) + 3000, `neto ${payout.net_amount}`);

    return `asignación COMPLETED, payout APPROVED, neto ${payout.net_amount}`;
  });

  section("Check-in: lo que no se da por bueno");

  await check("lejos del lugar: queda en revisión y no deja comenzar", async () => {
    const f = await montar("w-lejos");
    const onTheWay = await worker.client.rpc("mark_on_the_way", {
      p_assignment_id: f.assignmentId,
    });
    if (onTheWay.error) throw new Error(onTheWay.error.message);

    const checkIn = await worker.client.rpc("register_check_in", {
      p_assignment_id: f.assignmentId,
      p_consent: true,
      p_lat: LAT + 0.0135, // ~1,5 km al norte
      p_lng: LNG,
      p_accuracy_m: 15,
      p_source: "device",
    });
    if (checkIn.error) throw new Error(checkIn.error.message);
    const row = checkIn.data as Record<string, unknown>;
    expect(row.result === "OUT_OF_RANGE", `resultado ${row.result}`);
    expect(row.can_start === false, "dejó comenzar con el check-in fuera de rango");

    const start = await worker.client.rpc("start_job_work", { p_assignment_id: f.assignmentId });
    expect(start.error?.code === "23514", `comenzar debió rechazarse: ${start.error?.code}`);

    // La administración lo aprueba a mano y entonces sí.
    const checkInId = (
      orThrow(
        await admin
          .from("assignment_check_ins")
          .select("id")
          .eq("assignment_id", f.assignmentId)
          .single(),
      ) as { id: string }
    ).id;

    const review = await adminUser.client.rpc("review_check_in", {
      p_check_in_id: checkInId,
      p_approved: true,
      p_reason: "La foto de la fila coincide con el lugar del trabajo.",
    });
    if (review.error) throw new Error(`revisión: ${review.error.message}`);

    const retry = await worker.client.rpc("start_job_work", { p_assignment_id: f.assignmentId });
    if (retry.error) throw new Error(`tras aprobar: ${retry.error.message}`);

    return `${row.result} a ${row.distance_m} m, revisión manual desbloquea el inicio`;
  });

  await check("el cliente no ve las coordenadas del trabajador", async () => {
    const f = await montar("w-privacidad");
    await hastaEnCurso(f);

    const visible = orThrow(
      await client.client
        .from("assignment_check_ins")
        .select("id")
        .eq("assignment_id", f.assignmentId),
    ) as { id: string }[];
    expect(visible.length === 0, "el cliente puede leer la tabla de check-ins");

    const evidence = orThrow(
      await client.client
        .from("job_evidence")
        .select("title,body")
        .eq("assignment_id", f.assignmentId),
    ) as { title: string; body: string | null }[];
    const texto = evidence.map((e) => `${e.title} ${e.body ?? ""}`).join(" ");
    expect(!/-33\.|-70\./.test(texto), "la línea de tiempo lleva coordenadas");

    // Y las columnas heredadas ya no son legibles para nadie con sesión.
    const raw = await client.client.from("job_evidence").select("lat,lng").limit(1);
    expect(raw.error !== null, "las columnas de coordenadas siguen siendo legibles");

    return "0 filas de check-in y ninguna coordenada en la línea de tiempo";
  });

  section("Quién puede hacer qué");

  {
    const f = await montar("w-papeles");

    await mustFailWith("el cliente no avanza el trabajo por el trabajador", ["42501"], () =>
      client.client.rpc("mark_on_the_way", { p_assignment_id: f.assignmentId }),
    );

    await mustFailWith("el cliente no hace el check-in del trabajador", ["42501"], () =>
      client.client.rpc("register_check_in", {
        p_assignment_id: f.assignmentId,
        p_consent: true,
        p_lat: LAT,
        p_lng: LNG,
        p_accuracy_m: 10,
        p_source: "device",
      }),
    );

    await hastaEnCurso(f);

    await mustFailWith("el trabajador no aprueba su propio trabajo", ["42501"], () =>
      worker.client.rpc("approve_job_completion", {
        p_assignment_id: f.assignmentId,
        p_bonus_awarded: true,
      }),
    );

    await mustFailWith("el trabajador no genera el código de entrega", ["42501"], () =>
      worker.client.rpc("generate_handoff_code", { p_assignment_id: f.assignmentId }),
    );

    await mustFailWith("el trabajador no puede leer el código de entrega", ["42501"], () =>
      worker.client.rpc("get_handoff_code", { p_assignment_id: f.assignmentId }),
    );

    await mustFailWith("un tercero no publica evidencia en un trabajo ajeno", ["42501"], () =>
      outsider.client.rpc("add_job_evidence", {
        p_assignment_id: f.assignmentId,
        p_evidence_type: "NOTE",
        p_title: "Intruso",
        p_body: null,
        p_storage_path: null,
        p_mime_type: null,
        p_size_bytes: null,
        p_queue_ahead: null,
      }),
    );

    await mustFailWith("un tercero no abre una disputa ajena", ["42501"], () =>
      outsider.client.rpc("open_dispute", {
        p_assignment_id: f.assignmentId,
        p_reason: "Da igual",
        p_description: "Una descripción suficientemente larga para pasar la validación.",
      }),
    );

    await mustFailWith("nadie escribe el estado de la asignación a mano", ["42501"], () =>
      worker.client.from("assignments").update({ status: "COMPLETED" }).eq("id", f.assignmentId),
    );

    await mustFailWith("nadie forja un hito en la línea de tiempo", ["42501"], () =>
      worker.client.from("job_evidence").insert({
        job_id: f.jobId,
        assignment_id: f.assignmentId,
        author_id: worker.userId,
        evidence_type: "SYSTEM",
        title: "Hito falso",
      }),
    );

    await mustFailWith("nadie se inserta una extensión a mano", ["42501"], () =>
      worker.client.from("job_extensions").insert({
        assignment_id: f.assignmentId,
        requested_by: worker.userId,
        additional_minutes: 60,
        hourly_rate: 9000,
        additional_amount: 9000,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );

    await mustFailWith("un usuario común no resuelve una disputa", ["42501"], () =>
      client.client.rpc("resolve_dispute", {
        p_dispute_id: "00000000-0000-0000-0000-000000000000",
        p_resolution: "CLIENT_WINS",
        p_notes: "Me la resuelvo yo mismo.",
        p_refund_amount: null,
      }),
    );

    await mustFailWith("un usuario común no aprueba un pago al trabajador", ["42501"], () =>
      worker.client.rpc("approve_payout", {
        p_payout_id: "00000000-0000-0000-0000-000000000000",
        p_notes: null,
      }),
    );

    await mustFailWith("un usuario común no lee las colas del panel", ["42501"], () =>
      client.client.rpc("admin_pending_reviews"),
    );
  }

  section("Tiempo adicional");

  await check("solicitar, aceptar y que el cobro sume al pago del trabajador", async () => {
    const f = await montar("w-extension");
    await hastaEnCurso(f);

    const before = orThrow(
      await admin.from("payouts").select("net_amount").eq("assignment_id", f.assignmentId).single(),
    ) as { net_amount: number };

    const requested = await worker.client.rpc("request_job_extension", {
      p_assignment_id: f.assignmentId,
      p_minutes: 60,
      p_reason: "La fila avanza más lento de lo previsto.",
    });
    if (requested.error) throw new Error(`solicitud: ${requested.error.message}`);
    const extensionId = String(requested.data);

    // El trabajador no responde su propia solicitud.
    const selfAnswer = await worker.client.rpc("answer_job_extension", {
      p_extension_id: extensionId,
      p_accept: true,
    });
    expect(selfAnswer.error?.code === "42501", `autoaceptación: ${selfAnswer.error?.code}`);

    const answered = await client.client.rpc("answer_job_extension", {
      p_extension_id: extensionId,
      p_accept: true,
    });
    if (answered.error) throw new Error(`respuesta: ${answered.error.message}`);
    const paymentId = String((answered.data as Record<string, unknown>).payment_id);

    const started = await client.client.rpc("start_extension_payment", {
      p_extension_id: extensionId,
    });
    if (started.error) throw new Error(`cobro: ${started.error.message}`);

    const token = `mock-ext-${Math.random().toString(36).slice(2, 8)}`;
    orThrow(
      await admin
        .from("payments")
        .update({ status: "CREATED", provider: "mock", provider_transaction_id: token })
        .eq("id", paymentId)
        .select("id"),
    );
    const confirmed = await admin.rpc("confirm_payment_result", {
      p_payment_id: paymentId,
      p_provider: "mock",
      p_provider_event_id: `evt-${token}`,
      p_result: "PAID",
      p_amount: 9000,
      p_details: {},
    });
    if (confirmed.error) throw new Error(`confirmación: ${confirmed.error.message}`);

    const payment = orThrow(
      await admin.from("payments").select("status,review_reason").eq("id", paymentId).single(),
    ) as { status: string; review_reason: string | null };
    expect(
      payment.status === "PAID",
      `el cobro adicional quedó en ${payment.status} (${payment.review_reason})`,
    );

    const after = orThrow(
      await admin.from("payouts").select("net_amount,status").eq("assignment_id", f.assignmentId).single(),
    ) as { net_amount: number; status: string };

    expect(
      after.net_amount === before.net_amount + 9000 - Math.round(9000 * 0.14),
      `neto ${before.net_amount} → ${after.net_amount}`,
    );
    expect(after.status === "PENDING", `el pago se liberó solo: ${after.status}`);

    const asg = await assignmentStatus(f.assignmentId);
    expect(asg === "IN_PROGRESS", `el trabajo cambió de estado: ${asg}`);

    return `neto ${before.net_amount} → ${after.net_amount}, sin liberar nada`;
  });

  section("Disputas y pago al trabajador");

  await check("abrir retiene el pago y bloquea la aprobación", async () => {
    const f = await montar("w-disputa");
    await hastaEnCurso(f);

    const opened = await client.client.rpc("open_dispute", {
      p_assignment_id: f.assignmentId,
      p_reason: "Problema con la entrega",
      p_description: "El trabajador no consiguió lo acordado y quiero que lo revisen.",
    });
    if (opened.error) throw new Error(`apertura: ${opened.error.message}`);
    const disputeId = String(opened.data);

    const evidence = await client.client.rpc("add_dispute_evidence", {
      p_dispute_id: disputeId,
      p_body: "Adjunto lo que recibí.",
      p_storage_path: null,
      p_mime_type: null,
      p_size_bytes: null,
    });
    if (evidence.error) throw new Error(`prueba: ${evidence.error.message}`);

    const payout = orThrow(
      await admin.from("payouts").select("status").eq("assignment_id", f.assignmentId).single(),
    ) as { status: string };
    expect(payout.status === "HELD", `payout ${payout.status}`);

    const approve = await client.client.rpc("approve_job_completion", {
      p_assignment_id: f.assignmentId,
      p_bonus_awarded: true,
    });
    expect(approve.error?.code === "23514", `aprobar con disputa: ${approve.error?.code}`);

    const resolved = await adminUser.client.rpc("resolve_dispute", {
      p_dispute_id: disputeId,
      p_resolution: "PARTIAL",
      p_notes: "Se hizo parte del trabajo: se devuelve la mitad al cliente.",
      p_refund_amount: 9000,
    });
    if (resolved.error) throw new Error(`resolución: ${resolved.error.message}`);

    const after = orThrow(
      await admin
        .from("payouts")
        .select("status,net_amount")
        .eq("assignment_id", f.assignmentId)
        .single(),
    ) as { status: string; net_amount: number };
    const payment = orThrow(
      await admin.from("payments").select("status").eq("id", f.paymentId).single(),
    ) as { status: string };

    expect(after.status === "APPROVED", `tras resolver, payout ${after.status}`);
    expect(payment.status === "PAID", `el pago del cliente quedó en ${payment.status}`);

    return `retenido → resuelto parcial, neto ${after.net_amount}, devolución anotada`;
  });

  await check("aprobar y registrar la transferencia, con referencia y sin duplicar", async () => {
    const f = await montar("w-payout");
    await hastaEnCurso(f);

    const requested = await worker.client.rpc("request_job_completion", {
      p_assignment_id: f.assignmentId,
      p_note: "Trabajo terminado.",
    });
    if (requested.error) throw new Error(requested.error.message);

    const approved = await client.client.rpc("approve_job_completion", {
      p_assignment_id: f.assignmentId,
      p_bonus_awarded: false,
    });
    if (approved.error) throw new Error(approved.error.message);

    const payoutId = (
      orThrow(
        await admin.from("payouts").select("id").eq("assignment_id", f.assignmentId).single(),
      ) as { id: string }
    ).id;

    const short = await adminUser.client.rpc("mark_payout_paid", {
      p_payout_id: payoutId,
      p_bank_reference: "x",
      p_paid_at: null,
      p_notes: null,
    });
    expect(short.error?.code === "23514", `referencia corta: ${short.error?.code}`);

    const reference = `TRX-${RUN}`;
    const first = await adminUser.client.rpc("mark_payout_paid", {
      p_payout_id: payoutId,
      p_bank_reference: reference,
      p_paid_at: new Date().toISOString(),
      p_notes: "Transferencia manual",
    });
    if (first.error) throw new Error(first.error.message);

    const second = await adminUser.client.rpc("mark_payout_paid", {
      p_payout_id: payoutId,
      p_bank_reference: reference,
      p_paid_at: null,
      p_notes: null,
    });
    if (second.error) throw new Error(second.error.message);
    expect(
      (second.data as Record<string, unknown>).repeated === true,
      "registrar dos veces no se detectó como repetido",
    );

    const row = orThrow(
      await admin.from("payouts").select("status,bank_reference").eq("id", payoutId).single(),
    ) as { status: string; bank_reference: string };
    expect(row.status === "PAID" && row.bank_reference === reference, `payout ${row.status}`);

    // Y el trabajador ve su ganancia con esa referencia.
    const earnings = orThrow(
      await worker.client
        .from("worker_earnings")
        .select("status,bank_reference")
        .eq("assignment_id", f.assignmentId)
        .single(),
    ) as { status: string; bank_reference: string };
    expect(earnings.bank_reference === reference, "el trabajador no ve su transferencia");

    return `transferencia ${reference} registrada una sola vez y visible para el trabajador`;
  });

  section("Reseñas");

  await check("solo tras la aprobación, una por parte", async () => {
    const f = await montar("w-resena");
    await hastaEnCurso(f);

    const early = await client.client.rpc("submit_review", {
      p_assignment_id: f.assignmentId,
      p_overall: 5,
      p_punctuality: 5,
      p_communication: 5,
      p_compliance: 5,
      p_comment: "Antes de tiempo",
    });
    expect(early.error?.code === "23514", `reseña temprana: ${early.error?.code}`);

    await worker.client.rpc("request_job_completion", {
      p_assignment_id: f.assignmentId,
      p_note: null,
    });
    const approved = await client.client.rpc("approve_job_completion", {
      p_assignment_id: f.assignmentId,
      p_bonus_awarded: true,
    });
    if (approved.error) throw new Error(approved.error.message);

    const first = await client.client.rpc("submit_review", {
      p_assignment_id: f.assignmentId,
      p_overall: 5,
      p_punctuality: 5,
      p_communication: 4,
      p_compliance: 5,
      p_comment: "Puntual y claro.",
    });
    if (first.error) throw new Error(`reseña: ${first.error.message}`);

    const second = await client.client.rpc("submit_review", {
      p_assignment_id: f.assignmentId,
      p_overall: 1,
      p_punctuality: 1,
      p_communication: 1,
      p_compliance: 1,
      p_comment: "Me arrepentí",
    });
    expect(second.error?.code === "23505", `segunda reseña: ${second.error?.code}`);

    const profile = orThrow(
      await admin
        .from("worker_profiles")
        .select("average_rating,review_count,completed_jobs,worked_minutes")
        .eq("user_id", worker.userId)
        .single(),
    ) as { average_rating: number; review_count: number; completed_jobs: number; worked_minutes: number };

    expect(profile.review_count >= 1, "la reseña no se contó");
    expect(profile.completed_jobs >= 1, "los trabajos completados no se recalcularon");

    return `nota ${profile.average_rating}, ${profile.completed_jobs} completados, ${profile.worked_minutes} min`;
  });

  section("Carreras reales, repetidas");

  await check(`dos aprobaciones SIMULTÁNEAS, ${RACE_REPS} veces`, async () => {
    for (let i = 1; i <= RACE_REPS; i += 1) {
      const f = await montar(`w-carrera-aprob-${i}`);
      await hastaEnCurso(f);
      await worker.client.rpc("request_job_completion", {
        p_assignment_id: f.assignmentId,
        p_note: null,
      });

      const [a, b] = await Promise.all([
        client.client.rpc("approve_job_completion", {
          p_assignment_id: f.assignmentId,
          p_bonus_awarded: true,
        }),
        client.client.rpc("approve_job_completion", {
          p_assignment_id: f.assignmentId,
          p_bonus_awarded: true,
        }),
      ]);

      const repeated = [a, b]
        .map((r) => (r.data as Record<string, unknown> | null)?.repeated)
        .filter((v) => v === true).length;
      const applied = [a, b]
        .map((r) => (r.data as Record<string, unknown> | null)?.repeated)
        .filter((v) => v === false).length;

      expect(a.error === null && b.error === null, `repetición ${i}: ${a.error?.message ?? b.error?.message}`);
      expect(applied === 1 && repeated === 1, `repetición ${i}: ${applied} aplicadas, ${repeated} repetidas`);

      const payouts = orThrow(
        await admin
          .from("payouts")
          .select("id")
          .eq("assignment_id", f.assignmentId)
          .eq("status", "APPROVED"),
      ) as { id: string }[];
      const milestones = orThrow(
        await admin
          .from("job_evidence")
          .select("id")
          .eq("assignment_id", f.assignmentId)
          .eq("event_key", "completion_approved"),
      ) as { id: string }[];

      expect(payouts.length === 1, `repetición ${i}: ${payouts.length} payouts aprobados`);
      expect(milestones.length === 1, `repetición ${i}: ${milestones.length} hitos de aprobación`);
    }
    return `${RACE_REPS} veces: una aplicada, una repetida, un payout, un hito`;
  });

  await check(`aceptar y rechazar la MISMA extensión a la vez, ${RACE_REPS} veces`, async () => {
    let accepted = 0;
    let rejected = 0;
    for (let i = 1; i <= RACE_REPS; i += 1) {
      const f = await montar(`w-carrera-ext-${i}`);
      await hastaEnCurso(f);

      const requested = await worker.client.rpc("request_job_extension", {
        p_assignment_id: f.assignmentId,
        p_minutes: 60,
        p_reason: "carrera",
      });
      if (requested.error) throw new Error(requested.error.message);
      const extensionId = String(requested.data);

      const [a, b] = await Promise.all([
        client.client.rpc("answer_job_extension", { p_extension_id: extensionId, p_accept: true }),
        client.client.rpc("answer_job_extension", { p_extension_id: extensionId, p_accept: false }),
      ]);

      const errors = [a, b].filter((r) => r.error !== null).length;
      expect(errors === 1, `repetición ${i}: ${errors} respuestas rechazadas, se esperaba 1`);

      const row = orThrow(
        await admin.from("job_extensions").select("status").eq("id", extensionId).single(),
      ) as { status: string };
      const payments = orThrow(
        await admin.from("payments").select("id").eq("extension_id", extensionId),
      ) as { id: string }[];
      const assignment = orThrow(
        await admin
          .from("assignments")
          .select("extension_minutes")
          .eq("id", f.assignmentId)
          .single(),
      ) as { extension_minutes: number };

      if (row.status === "ACCEPTED") {
        accepted += 1;
        expect(payments.length === 1, `repetición ${i}: ${payments.length} cobros adicionales`);
        expect(assignment.extension_minutes === 60, `repetición ${i}: ${assignment.extension_minutes} min`);
      } else {
        rejected += 1;
        expect(row.status === "REJECTED", `repetición ${i}: extensión ${row.status}`);
        expect(payments.length === 0, `repetición ${i}: cobro creado tras rechazar`);
        expect(assignment.extension_minutes === 0, `repetición ${i}: ${assignment.extension_minutes} min`);
      }
    }
    return `aceptó ${accepted}, rechazó ${rejected}; nunca las dos`;
  });

  section("Invariantes sobre todo lo creado");

  await check("ninguna violación financiera tras el recorrido completo", async () => {
    const { data, error } = await admin.rpc("payment_invariant_violations");
    // La función vive en `app_private`, fuera del esquema expuesto: si no se
    // puede llamar por API, se comprueban las reglas desde aquí.
    if (error) {
      const assignments = orThrow(
        await admin.from("assignments").select("id,status,job_id,worker_id").in("job_id", createdJobs),
      ) as { id: string; status: string; job_id: string; worker_id: string }[];
      const payouts = orThrow(
        await admin
          .from("payouts")
          .select("id,assignment_id,payment_id,status,worker_id")
          .in(
            "assignment_id",
            assignments.map((a) => a.id),
          ),
      ) as { id: string; assignment_id: string; payment_id: string | null; status: string; worker_id: string }[];
      const jobs = orThrow(
        await admin.from("jobs").select("id,status").in("id", createdJobs),
      ) as { id: string; status: string }[];
      const jobById = new Map(jobs.map((j) => [j.id, j]));
      const asgById = new Map(assignments.map((a) => [a.id, a]));

      const problems: string[] = [];
      const dead = new Set(["CANCELLED", "CANCELLATION_PENDING", "EXPIRED"]);
      const perAssignment = new Map<string, number>();

      for (const p of payouts) {
        const a = asgById.get(p.assignment_id);
        const j = a ? jobById.get(a.job_id) : undefined;
        if (!a || !j) problems.push(`payout ${p.id} huérfano`);
        else {
          if (dead.has(j.status) && p.status !== "CANCELLED") {
            problems.push(`payout ${p.id} vivo sobre trabajo ${j.status}`);
          }
          if (a.worker_id !== p.worker_id) problems.push(`payout ${p.id} a otro trabajador`);
        }
        if (!p.payment_id) problems.push(`payout ${p.id} sin pago`);
        perAssignment.set(p.assignment_id, (perAssignment.get(p.assignment_id) ?? 0) + 1);
      }
      for (const [id, n] of perAssignment) {
        if (n > 1) problems.push(`asignación ${id} con ${n} payouts`);
      }

      expect(problems.length === 0, problems.join("; "));
      return `${assignments.length} asignaciones y ${payouts.length} payouts: cero violaciones`;
    }

    const rows = (data ?? []) as { rule: string; entity_id: string }[];
    expect(rows.length === 0, rows.map((r) => `${r.rule}:${r.entity_id}`).join(", "));
    return "cero violaciones";
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

  await Promise.all(
    [client, worker, outsider, adminUser].map((s) => s.client.auth.signOut()),
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(
    "\n✗ La verificación de la ejecución se interrumpió:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
