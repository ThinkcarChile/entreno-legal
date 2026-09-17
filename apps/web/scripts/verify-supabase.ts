/**
 * Verificación de integración contra un proyecto Supabase REAL.
 *
 * Recorre el marketplace completo con cuentas reales y comprueba, además del
 * camino feliz, que las operaciones prohibidas fallen de verdad en el backend y
 * no solo en la interfaz.
 *
 *   npm run verify:supabase
 *
 * Necesita en .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY  (o NEXT_PUBLIC_SUPABASE_ANON_KEY)
 *   SUPABASE_SECRET_KEY                   (o SUPABASE_SERVICE_ROLE_KEY)
 *   E2E_CLIENT_EMAIL / E2E_CLIENT_PASSWORD
 *   E2E_WORKER_EMAIL / E2E_WORKER_PASSWORD
 *   E2E_OUTSIDER_EMAIL / E2E_OUTSIDER_PASSWORD
 *   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD
 *
 * La clave privada se usa solo para dos cosas que no tienen otra vía: crear las
 * cuentas de prueba ya confirmadas y dar el rol de administración a una de
 * ellas. Todo lo demás se hace con la sesión de cada usuario, igual que la
 * aplicación.
 *
 * Sale con código distinto de cero si alguna comprobación falla.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ entorno */

function loadEnvLocal(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      const raw = readFileSync(resolve(here, "..", file), "utf8");
      for (const line of raw.split("\n")) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (!match) continue;
        const value = match[2].replace(/^["']|["']$/g, "");
        if (value && !process.env[match[1]]) process.env[match[1]] = value;
      }
    } catch {
      // El archivo puede no existir: las variables pueden venir del entorno.
    }
  }
}

loadEnvLocal();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "";
const SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

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
  console.error("\n✗ Faltan variables para ejecutar la verificación:\n");
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
  return `V${String(counter).padStart(2, "0")}`;
}

/** Comprueba algo que DEBE funcionar. El texto devuelto se muestra en el informe. */
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

/** Comprueba que algo PROHIBIDO falle. Si funciona, es un agujero de seguridad. */
async function mustFail(name: string, fn: () => Promise<unknown>): Promise<void> {
  const id = nextId();
  try {
    await fn();
    results.push({ id, name, ok: false, detail: "la operación prohibida fue permitida" });
    console.log(`  ${id} FALLO ${name} — la operación prohibida fue PERMITIDA`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ id, name, ok: true, detail });
    console.log(`  ${id} OK   ${name} — bloqueado`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title}`);
}

/** Convierte un error de PostgREST en excepción, para usarlo con mustFail. */
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

/** Un cliente independiente por usuario: las sesiones no se comparten. */
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

/**
 * Crea la cuenta si no existe (ya confirmada) y abre sesión.
 *
 * Se usa la API administrativa para el alta porque un proyecto con confirmación
 * de correo activada dejaría la cuenta sin poder entrar, y este script no puede
 * leer buzones.
 */
async function ensureAccount(acc: Account): Promise<Session> {
  const client = anonClient();

  let signIn = await client.auth.signInWithPassword({
    email: acc.email,
    password: acc.password,
  });

  if (signIn.error) {
    const created = await admin.auth.admin.createUser({
      email: acc.email,
      password: acc.password,
      email_confirm: true,
    });

    if (created.error && !/already/i.test(created.error.message)) {
      throw new Error(`no se pudo crear la cuenta ${acc.label}: ${created.error.message}`);
    }

    signIn = await client.auth.signInWithPassword({
      email: acc.email,
      password: acc.password,
    });
  }

  if (signIn.error || !signIn.data.user) {
    throw new Error(`no se pudo iniciar sesión como ${acc.label}: ${signIn.error?.message}`);
  }

  return { client, userId: signIn.data.user.id, email: acc.email };
}

/* ----------------------------------------------------------------- flujo */

const RUN = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

async function main(): Promise<void> {
  console.log(`\nVerificación contra Supabase real`);
  console.log(`Proyecto: ${new URL(SUPABASE_URL).hostname}`);
  console.log(`Ejecución: ${RUN}\n`);

  section("Conexión y esquema");

  await check("el esquema está aplicado", async () => {
    const settings = orThrow(
      await admin.from("platform_settings").select("commission_bps").maybeSingle(),
    );
    expect(Boolean(settings), "falta la fila de platform_settings: aplica las migraciones");
    return `comisión ${(settings as { commission_bps: number }).commission_bps} pb`;
  });

  await check("la semilla geográfica está aplicada", async () => {
    const { count, error } = await admin
      .from("communes")
      .select("code", { count: "exact", head: true });
    if (error) throw new Error(error.message);
    expect((count ?? 0) >= 346, `hay ${count} comunas, se esperaban 346`);
    return `${count} comunas`;
  });

  section("Cuentas y sesiones");

  const client = await ensureAccount(CLIENT);
  const worker = await ensureAccount(WORKER);
  const outsider = await ensureAccount(OUTSIDER);
  const adminUser = await ensureAccount(ADMIN);

  await check("cuatro sesiones simultáneas, cada una con su identidad", async () => {
    const ids = await Promise.all(
      [client, worker, outsider, adminUser].map(async (s) => {
        const { data } = await s.client.auth.getClaims();
        return data?.claims?.sub as string | undefined;
      }),
    );
    expect(ids[0] === client.userId, "la sesión del cliente devolvió otra identidad");
    expect(ids[1] === worker.userId, "la sesión del trabajador devolvió otra identidad");
    expect(new Set(ids).size === 4, "dos sesiones comparten identidad");
    return "sin cruce entre sesiones";
  });

  await check("el rol de administración queda asignado", async () => {
    orThrow(
      await admin.from("profiles").update({ role: "ADMIN" }).eq("id", adminUser.userId).select("id"),
    );
    return adminUser.email;
  });

  section("Onboarding");

  await check("el cliente completa su onboarding", async () => {
    const { error } = await client.client.rpc("complete_onboarding", {
      p_first_name: "Paula",
      p_last_name: "Control",
      p_phone: "+56911110001",
      p_region_code: "13",
      p_commune_code: "13-providencia",
      p_avatar_url: null,
      p_wants_client: true,
      p_wants_worker: false,
    });
    if (error) throw new Error(error.message);
    return "cliente en Providencia";
  });

  await check("el trabajador completa su onboarding y su perfil", async () => {
    const onboarding = await worker.client.rpc("complete_onboarding", {
      p_first_name: "Andrés",
      p_last_name: "Control",
      p_phone: "+56911110002",
      p_region_code: "13",
      p_commune_code: "13-santiago",
      p_avatar_url: null,
      p_wants_client: false,
      p_wants_worker: true,
    });
    if (onboarding.error) throw new Error(onboarding.error.message);

    orThrow(
      await worker.client
        .from("worker_profiles")
        .update({
          headline: "Filas y trámites en el centro de Santiago",
          base_hourly_rate: 10000,
          availability_note: "Lunes a domingo, incluidas madrugadas",
          accepts_overnight: true,
        })
        .eq("user_id", worker.userId)
        .select("user_id"),
    );

    const areas = await worker.client.rpc("set_worker_service_areas", {
      p_areas: [{ regionCode: "13", communeCode: "13-providencia", radiusKm: 15 }],
    });
    if (areas.error) throw new Error(areas.error.message);
    return "perfil y zona de trabajo guardados";
  });

  await check("el teléfono queda fuera del perfil público", async () => {
    const profile = orThrow(
      await outsider.client.from("profiles").select("*").eq("id", client.userId).maybeSingle(),
    ) as Record<string, unknown> | null;
    expect(Boolean(profile), "el perfil público debería ser visible");
    expect(!("phone" in (profile ?? {})), "el perfil público expone un teléfono");
    return "solo nombre, inicial y comuna";
  });

  section("Verificación obligatoria");

  await check("el trabajador arranca sin verificar", async () => {
    orThrow(
      await admin
        .from("worker_profiles")
        .update({
          verification_status: "UNVERIFIED",
          identity_verified: false,
          is_accepting_jobs: false,
          level: "NUEVO",
        })
        .eq("user_id", worker.userId)
        .select("user_id"),
    );
    return "estado UNVERIFIED";
  });

  section("Publicación real");

  let jobId = "";
  await check("el cliente publica un trabajo", async () => {
    const { data, error } = await client.client.rpc("publish_job", {
      p_payload: {
        categoryId: (
          orThrow(
            await admin
              .from("job_categories")
              .select("id")
              .eq("slug", "filas-lanzamientos-tiendas")
              .maybeSingle(),
          ) as { id: string }
        ).id,
        title: `Fila para lanzamiento de zapatillas ${RUN}`,
        description:
          "Necesito que alguien tome lugar en la fila desde temprano y me avise cómo avanza durante la mañana.",
        instructions: "Avísame apenas llegues y mándame una foto de la fila.",
        regionCode: "13",
        communeCode: "13-providencia",
        placeName: "Tienda de prueba",
        addressLine: "Av. Providencia 1234, local 5",
        addressNotes: "Entrada lateral por el pasaje",
        lat: -33.4265,
        lng: -70.6153,
        startsAt: new Date(Date.now() + 3 * 86400000).toISOString(),
        estimatedDurationMinutes: 300,
        urgency: "NORMAL",
        objectiveType: "AS_FRONT_AS_POSSIBLE",
        bonusAmount: "15000",
        bonusConditions: "Si quedas entre los primeros diez",
        hourlyRate: "10000",
        suggestedHourlyMin: "10000",
        suggestedHourlyMax: "12500",
      },
    });
    if (error) throw new Error(error.message);
    jobId = String(data);
    return jobId;
  });

  await check("el trabajo quedó guardado con su rango sugerido", async () => {
    const job = orThrow(
      await admin
        .from("jobs")
        .select("status,reference,suggested_hourly_min,suggested_hourly_max,approx_lat,timezone,bonus_amount")
        .eq("id", jobId)
        .maybeSingle(),
    ) as Record<string, unknown>;
    expect(job.status === "PUBLISHED", `estado inesperado: ${job.status}`);
    expect(Boolean(job.suggested_hourly_min), "no se guardó el rango sugerido");
    expect(job.timezone === "America/Santiago", "zona horaria incorrecta");
    expect(Number(job.bonus_amount) === 15000, "no se guardó el bono");
    return `${job.reference}, sugerido ${job.suggested_hourly_min}–${job.suggested_hourly_max}`;
  });

  await check("la dirección exacta quedó en la tabla privada", async () => {
    const location = orThrow(
      await admin.from("job_private_location").select("address_line,lat").eq("job_id", jobId).maybeSingle(),
    ) as Record<string, unknown>;
    expect(Boolean(location), "no se creó la ubicación privada");
    expect(String(location.address_line).includes("Providencia 1234"), "dirección incorrecta");
    return String(location.address_line);
  });

  await check("la publicación quedó en la bitácora de auditoría", async () => {
    const logs = orThrow(
      await admin.from("audit_logs").select("action").eq("entity_id", jobId),
    ) as { action: string }[];
    expect(logs.length > 0, "no hay entradas de auditoría para el trabajo");
    return `${logs.length} entradas`;
  });

  section("Privacidad frente a un trabajador no asignado");

  await check("el trabajador ve el trabajo publicado", async () => {
    const job = orThrow(
      await worker.client
        .from("jobs")
        .select("id,commune_code,region_code,approx_lat,approx_lng,place_name")
        .eq("id", jobId)
        .maybeSingle(),
    ) as Record<string, unknown> | null;
    expect(Boolean(job), "el trabajo publicado debería ser visible");
    expect(job!.commune_code === "13-providencia", "no ve la comuna");
    expect(job!.approx_lat !== null, "no ve la ubicación aproximada");
    return `comuna y punto aproximado (${job!.approx_lat}, ${job!.approx_lng})`;
  });

  await check("el trabajador NO obtiene la dirección exacta", async () => {
    const { data, error } = await worker.client
      .from("job_private_location")
      .select("address_line,lat,lng")
      .eq("job_id", jobId);
    if (error) throw new Error(error.message);
    expect((data ?? []).length === 0, "RLS dejó pasar la dirección exacta");
    return "0 filas";
  });

  await check("el trabajador NO obtiene los datos privados del cliente", async () => {
    const { data, error } = await worker.client
      .from("user_private_data")
      .select("phone,rut,contact_email")
      .eq("user_id", client.userId);
    if (error) throw new Error(error.message);
    expect((data ?? []).length === 0, "RLS dejó pasar datos personales del cliente");
    return "0 filas";
  });

  section("Regla de verificación");

  await mustFail("un trabajador sin verificar no puede ofertar (API directa)", async () => {
    const { error } = await worker.client.from("job_offers").insert({
      job_id: jobId,
      worker_id: worker.userId,
      hourly_rate: 9000,
      estimated_total: 45000,
      message: "Intento sin verificación",
    });
    if (error) throw new Error(error.message);
  });

  await mustFail("un trabajador no puede autoverificarse", async () => {
    const { error } = await worker.client
      .from("worker_profiles")
      .update({ verification_status: "VERIFIED", trust_index: 100 })
      .eq("user_id", worker.userId);
    if (error) throw new Error(error.message);
    const row = orThrow(
      await admin
        .from("worker_profiles")
        .select("verification_status")
        .eq("user_id", worker.userId)
        .maybeSingle(),
    ) as { verification_status: string };
    if (row.verification_status === "VERIFIED") return;
    throw new Error("la actualización no tuvo efecto");
  });

  let verificationId = "";
  await check("el trabajador solicita verificación", async () => {
    const { data, error } = await worker.client.rpc("request_worker_verification", {
      p_document_type: "CEDULA",
      p_document_path: null,
      p_selfie_path: null,
    });
    if (error) throw new Error(error.message);
    verificationId = String(data);
    return "estado PENDING";
  });

  await mustFail("un usuario común no puede resolver una verificación", async () => {
    const { error } = await outsider.client.rpc("review_worker_verification", {
      p_verification_id: verificationId,
      p_status: "VERIFIED",
      p_reason: null,
    });
    if (error) throw new Error(error.message);
  });

  await check("la administración verifica al trabajador", async () => {
    const { error } = await adminUser.client.rpc("review_worker_verification", {
      p_verification_id: verificationId,
      p_status: "VERIFIED",
      p_reason: null,
    });
    if (error) throw new Error(error.message);

    const row = orThrow(
      await admin
        .from("worker_profiles")
        .select("verification_status,level")
        .eq("user_id", worker.userId)
        .maybeSingle(),
    ) as { verification_status: string; level: string };
    expect(row.verification_status === "VERIFIED", "la verificación no se aplicó");
    return `${row.verification_status} / ${row.level}`;
  });

  section("Ofertas");

  let offerId = "";
  await check("el trabajador envía su oferta", async () => {
    const offer = orThrow(
      await worker.client
        .from("job_offers")
        .insert({
          job_id: jobId,
          worker_id: worker.userId,
          hourly_rate: 9000,
          estimated_total: 45000,
          message: "Vivo cerca y llego media hora antes.",
          estimated_arrival_at: new Date(Date.now() + 3 * 86400000 - 1800000).toISOString(),
        })
        .select("id,status,hourly_rate,estimated_total,estimated_arrival_at")
        .maybeSingle(),
    ) as Record<string, unknown>;
    offerId = String(offer.id);
    expect(offer.status === "PENDING", "la oferta no quedó pendiente");
    expect(Number(offer.hourly_rate) === 9000, "tarifa incorrecta");
    expect(Number(offer.estimated_total) === 45000, "estimación incorrecta");
    expect(Boolean(offer.estimated_arrival_at), "no se guardó la hora de llegada");
    return "tarifa, total, mensaje y hora propuesta correctos";
  });

  await mustFail("no se admite una segunda oferta activa al mismo trabajo", async () => {
    const { error } = await worker.client.from("job_offers").insert({
      job_id: jobId,
      worker_id: worker.userId,
      hourly_rate: 8000,
      estimated_total: 40000,
    });
    if (error) throw new Error(error.message);
  });

  await mustFail("el cliente no puede modificar la oferta del trabajador", async () => {
    const { error } = await client.client
      .from("job_offers")
      .update({ hourly_rate: 1000 })
      .eq("id", offerId);
    if (error) throw new Error(error.message);
    const row = orThrow(
      await admin.from("job_offers").select("hourly_rate").eq("id", offerId).maybeSingle(),
    ) as { hourly_rate: number };
    if (Number(row.hourly_rate) === 1000) return;
    throw new Error("la actualización no tuvo efecto");
  });

  section("Chat y Realtime");

  let conversationId = "";
  await check("se abre la conversación del trabajo", async () => {
    const { data, error } = await client.client.rpc("open_job_conversation", {
      p_job_id: jobId,
      p_worker_id: worker.userId,
    });
    if (error) throw new Error(error.message);
    conversationId = String(data);
    return conversationId;
  });

  await check("el trabajador recibe un mensaje por Realtime, sin recargar", async () => {
    const received = new Promise<string>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error("no llegó el mensaje por Realtime en 15 s")),
        15000,
      );

      const channel = worker.client
        .channel(`verify:${conversationId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            filter: `conversation_id=eq.${conversationId}`,
          },
          (payload) => {
            clearTimeout(timer);
            void worker.client.removeChannel(channel);
            resolvePromise(String((payload.new as Record<string, unknown>).body));
          },
        )
        .subscribe((status) => {
          // Se envía recién cuando la suscripción está activa: sin esperas fijas.
          if (status === "SUBSCRIBED") {
            void client.client.from("messages").insert({
              conversation_id: conversationId,
              sender_id: client.userId,
              message_type: "TEXT",
              body: "¿Puedes llegar antes de las 05:00?",
            });
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timer);
            rejectPromise(new Error(`la suscripción falló: ${status}`));
          }
        });
    });

    const body = await received;
    return `recibido: "${body}"`;
  });

  await check("el trabajador responde y el cliente lo recibe", async () => {
    const received = new Promise<string>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error("no llegó la respuesta por Realtime en 15 s")),
        15000,
      );

      const channel = client.client
        .channel(`verify-back:${conversationId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            filter: `conversation_id=eq.${conversationId}`,
          },
          (payload) => {
            clearTimeout(timer);
            void client.client.removeChannel(channel);
            resolvePromise(String((payload.new as Record<string, unknown>).body));
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            void worker.client.from("messages").insert({
              conversation_id: conversationId,
              sender_id: worker.userId,
              message_type: "TEXT",
              body: "Sí, llego 04:30 y te confirmo con una foto.",
            });
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timer);
            rejectPromise(new Error(`la suscripción falló: ${status}`));
          }
        });
    });

    const body = await received;
    return `recibido: "${body}"`;
  });

  await check("un tercero no puede leer la conversación", async () => {
    const { data, error } = await outsider.client
      .from("messages")
      .select("body")
      .eq("conversation_id", conversationId);
    if (error) throw new Error(error.message);
    expect((data ?? []).length === 0, "RLS dejó leer una conversación ajena");

    const conv = await outsider.client
      .from("conversations")
      .select("id")
      .eq("id", conversationId);
    expect((conv.data ?? []).length === 0, "RLS dejó ver una conversación ajena");
    return "0 mensajes y 0 conversaciones visibles";
  });

  await mustFail("un tercero no puede escribir en la conversación", async () => {
    const { error } = await outsider.client.from("messages").insert({
      conversation_id: conversationId,
      sender_id: outsider.userId,
      message_type: "TEXT",
      body: "Intruso",
    });
    if (error) throw new Error(error.message);
  });

  section("Aceptación de la oferta");

  let assignmentId = "";
  await check("el cliente acepta la oferta", async () => {
    const { data, error } = await client.client.rpc("accept_job_offer", { p_offer_id: offerId });
    if (error) throw new Error(error.message);
    assignmentId = String(data);

    const [job, offer, assignment, notifications] = await Promise.all([
      admin.from("jobs").select("status").eq("id", jobId).maybeSingle(),
      admin.from("job_offers").select("status").eq("id", offerId).maybeSingle(),
      admin.from("assignments").select("status,agreed_total,bonus_amount").eq("id", assignmentId).maybeSingle(),
      admin.from("notifications").select("notification_type").eq("user_id", worker.userId),
    ]);

    expect((job.data as { status: string }).status === "OFFER_ACCEPTED", "el trabajo no cambió de estado");
    expect((offer.data as { status: string }).status === "ACCEPTED", "la oferta no quedó aceptada");
    expect(Boolean(assignment.data), "no se creó la asignación");
    expect(
      (notifications.data ?? []).some((n) => n.notification_type === "OFFER_ACCEPTED"),
      "no se emitió la notificación al trabajador",
    );
    return `asignación ${assignmentId}`;
  });

  await check("la aceptación quedó auditada", async () => {
    const logs = orThrow(
      await admin.from("audit_logs").select("action").eq("action", "offer_accepted"),
    ) as { action: string }[];
    expect(logs.length > 0, "no hay registro de auditoría de la aceptación");
    return `${logs.length} aceptaciones registradas`;
  });

  section("Dirección tras la asignación");

  await check("el trabajador asignado ya ve la dirección", async () => {
    const location = orThrow(
      await worker.client
        .from("job_private_location")
        .select("address_line,address_notes")
        .eq("job_id", jobId)
        .maybeSingle(),
    ) as Record<string, unknown> | null;
    expect(Boolean(location), "el trabajador asignado no puede ver la dirección");
    return String(location!.address_line);
  });

  await check("un tercero sigue sin verla", async () => {
    const { data } = await outsider.client
      .from("job_private_location")
      .select("address_line")
      .eq("job_id", jobId);
    expect((data ?? []).length === 0, "un tercero puede ver la dirección");
    return "0 filas";
  });

  section("Pago protegido simulado");

  let paymentId = "";
  await check("el cliente inicia el pago y los montos los calcula el servidor", async () => {
    const { data, error } = await client.client.rpc("start_protected_payment", {
      p_assignment_id: assignmentId,
    });
    if (error) throw new Error(error.message);
    paymentId = String(data);

    const payment = orThrow(
      await admin.from("payments").select("amount,status,purpose").eq("id", paymentId).maybeSingle(),
    ) as { amount: number; status: string; purpose: string };

    // 45.000 de servicio + 15.000 de bono comprometido.
    expect(payment.amount === 60000, `monto inesperado: ${payment.amount}`);
    expect(payment.status === "PENDING", `estado inesperado: ${payment.status}`);
    return `cobro ${payment.amount} CLP`;
  });

  await check("el desglose de comisión lo calcula la base", async () => {
    const summary = orThrow(
      await client.client
        .from("assignment_payment_summary")
        .select("service_amount,bonus_amount,commission_amount,worker_receives,client_total,commission_bps")
        .eq("assignment_id", assignmentId)
        .maybeSingle(),
    ) as Record<string, number>;

    const expectedCommission = Math.round((summary.service_amount * summary.commission_bps) / 10000);
    expect(
      summary.commission_amount === expectedCommission,
      `comisión ${summary.commission_amount}, esperada ${expectedCommission}`,
    );
    expect(
      summary.worker_receives === summary.service_amount - summary.commission_amount + summary.bonus_amount,
      "el monto del trabajador no cuadra",
    );
    expect(
      summary.client_total === summary.service_amount + summary.bonus_amount,
      "el total del cliente no cuadra",
    );
    return `recibe ${summary.worker_receives}, comisión ${summary.commission_amount}, paga ${summary.client_total}`;
  });

  await mustFail("el cliente no puede alterar el importe del pago", async () => {
    const { error } = await client.client
      .from("payments")
      .update({ amount: 1, status: "PAID" })
      .eq("id", paymentId);
    if (error) throw new Error(error.message);
    const row = orThrow(
      await admin.from("payments").select("amount").eq("id", paymentId).maybeSingle(),
    ) as { amount: number };
    if (row.amount === 1) return;
    throw new Error("la actualización no tuvo efecto");
  });

  await mustFail("el cliente no puede inventar un pago ya confirmado", async () => {
    const { error } = await client.client.from("payments").insert({
      job_id: jobId,
      assignment_id: assignmentId,
      client_id: client.userId,
      purpose: "JOB",
      status: "PAID",
      amount: 1,
      provider: "mock",
    });
    if (error) throw new Error(error.message);
  });

  await mustFail("el trabajo no avanza sin pago confirmado", async () => {
    const { error } = await worker.client
      .from("assignments")
      .update({ status: "ON_THE_WAY" })
      .eq("id", assignmentId);
    if (error) throw new Error(error.message);
    const row = orThrow(
      await admin.from("assignments").select("status").eq("id", assignmentId).maybeSingle(),
    ) as { status: string };
    if (row.status === "ON_THE_WAY") return;
    throw new Error("la actualización no tuvo efecto");
  });

  await check("el pago simulado se confirma y habilita el trabajo", async () => {
    // Lo que en la aplicación hace la ruta /pagos/retorno tras confirmar con el
    // proveedor: una escritura de servidor, nunca del navegador.
    orThrow(
      await admin
        .from("payments")
        .update({ status: "PAID", paid_at: new Date().toISOString() })
        .eq("id", paymentId)
        .select("id"),
    );

    const [job, assignment, payout] = await Promise.all([
      admin.from("jobs").select("status").eq("id", jobId).maybeSingle(),
      admin.from("assignments").select("status").eq("id", assignmentId).maybeSingle(),
      admin.from("payouts").select("commission_amount,net_amount,status").eq("assignment_id", assignmentId).maybeSingle(),
    ]);

    expect((job.data as { status: string }).status === "PAID", "el trabajo no quedó pagado");
    expect(
      (assignment.data as { status: string }).status === "CONFIRMED",
      "la asignación no quedó confirmada",
    );
    expect(Boolean(payout.data), "no se generó el payout");
    const p = payout.data as { commission_amount: number; net_amount: number };
    return `payout neto ${p.net_amount}, comisión ${p.commission_amount}`;
  });

  await check("ahora sí el trabajador puede avanzar", async () => {
    orThrow(
      await worker.client
        .from("assignments")
        .update({ status: "ON_THE_WAY" })
        .eq("id", assignmentId)
        .select("id"),
    );
    const row = orThrow(
      await admin.from("assignments").select("status").eq("id", assignmentId).maybeSingle(),
    ) as { status: string };
    expect(row.status === "ON_THE_WAY", "no avanzó el estado");
    return "ON_THE_WAY";
  });

  section("Concurrencia al aceptar");

  await check("dos aceptaciones simultáneas dejan una sola asignación", async () => {
    // Segundo trabajo con dos ofertas de dos trabajadores verificados.
    const secondWorker = await ensureAccount({
      label: "trabajador 2",
      email: WORKER.email.replace("@", "+race@"),
      password: WORKER.password,
    });

    await secondWorker.client.rpc("complete_onboarding", {
      p_first_name: "Carmen",
      p_last_name: "Control",
      p_phone: "+56911110003",
      p_region_code: "13",
      p_commune_code: "13-santiago",
      p_avatar_url: null,
      p_wants_client: false,
      p_wants_worker: true,
    });

    orThrow(
      await admin
        .from("worker_profiles")
        .update({ verification_status: "VERIFIED", identity_verified: true })
        .eq("user_id", secondWorker.userId)
        .select("user_id"),
    );

    const categoryId = (
      orThrow(
        await admin.from("job_categories").select("id").eq("slug", "filas-conciertos-eventos").maybeSingle(),
      ) as { id: string }
    ).id;

    const raceJob = await client.client.rpc("publish_job", {
      p_payload: {
        categoryId,
        title: `Prueba de concurrencia ${RUN}`,
        description:
          "Trabajo creado por la verificación automatizada para comprobar la aceptación atómica.",
        regionCode: "13",
        communeCode: "13-santiago",
        addressLine: "Alameda 1000",
        startsAt: new Date(Date.now() + 4 * 86400000).toISOString(),
        estimatedDurationMinutes: 240,
        objectiveType: "HOLD_PLACE",
        hourlyRate: "10000",
      },
    });
    if (raceJob.error) throw new Error(raceJob.error.message);
    const raceJobId = String(raceJob.data);

    const offerA = orThrow(
      await worker.client
        .from("job_offers")
        .insert({ job_id: raceJobId, worker_id: worker.userId, hourly_rate: 9000, estimated_total: 36000 })
        .select("id")
        .maybeSingle(),
    ) as { id: string };

    const offerB = orThrow(
      await secondWorker.client
        .from("job_offers")
        .insert({
          job_id: raceJobId,
          worker_id: secondWorker.userId,
          hourly_rate: 11000,
          estimated_total: 44000,
        })
        .select("id")
        .maybeSingle(),
    ) as { id: string };

    // Dos aceptaciones en paralelo, sin barrera: gana el bloqueo de la base.
    const [resultA, resultB] = await Promise.allSettled([
      client.client.rpc("accept_job_offer", { p_offer_id: offerA.id }),
      client.client.rpc("accept_job_offer", { p_offer_id: offerB.id }),
    ]);

    const succeeded = [resultA, resultB].filter(
      (r) => r.status === "fulfilled" && !r.value.error,
    ).length;

    const assignments = orThrow(
      await admin.from("assignments").select("id").eq("job_id", raceJobId),
    ) as { id: string }[];
    const accepted = orThrow(
      await admin.from("job_offers").select("id").eq("job_id", raceJobId).eq("status", "ACCEPTED"),
    ) as { id: string }[];

    expect(succeeded === 1, `${succeeded} aceptaciones tuvieron éxito, se esperaba 1`);
    expect(assignments.length === 1, `${assignments.length} asignaciones, se esperaba 1`);
    expect(accepted.length === 1, `${accepted.length} ofertas aceptadas, se esperaba 1`);

    await secondWorker.client.auth.signOut();
    return "1 asignación y 1 oferta aceptada";
  });

  section("Panel de administración");

  await check("la administración lista las verificaciones", async () => {
    const { data, error } = await adminUser.client.from("worker_verifications").select("id,status");
    if (error) throw new Error(error.message);
    return `${(data ?? []).length} solicitudes visibles`;
  });

  await check("un usuario común no ve las verificaciones ajenas", async () => {
    const { data, error } = await outsider.client.from("worker_verifications").select("id");
    if (error) throw new Error(error.message);
    expect((data ?? []).length === 0, "un usuario común ve verificaciones ajenas");
    return "0 filas";
  });

  await check("un usuario común no ve la bitácora de auditoría", async () => {
    const { data, error } = await outsider.client.from("audit_logs").select("id").limit(5);
    if (error) throw new Error(error.message);
    expect((data ?? []).length === 0, "un usuario común lee la bitácora");
    return "0 filas";
  });

  await mustFail("un usuario común no puede alterar la bitácora", async () => {
    const { error } = await outsider.client.from("audit_logs").delete().neq("id", "");
    if (error) throw new Error(error.message);
    const { count } = await admin
      .from("audit_logs")
      .select("id", { count: "exact", head: true });
    if ((count ?? 0) === 0) return;
    throw new Error("el borrado no tuvo efecto");
  });

  section("Storage");

  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  let avatarPath = "";
  await check("el usuario sube su fotografía de perfil", async () => {
    avatarPath = `${worker.userId}/${crypto.randomUUID()}.png`;
    const { error } = await worker.client.storage
      .from("avatars")
      .upload(avatarPath, pixel, { contentType: "image/png" });
    if (error) throw new Error(error.message);
    return avatarPath;
  });

  await mustFail("un usuario no puede escribir en la carpeta de otro", async () => {
    const { error } = await outsider.client.storage
      .from("avatars")
      .upload(`${worker.userId}/${crypto.randomUUID()}.png`, pixel, { contentType: "image/png" });
    if (error) throw new Error(error.message);
  });

  await mustFail("un usuario no puede sobrescribir el archivo de otro", async () => {
    const { error } = await outsider.client.storage
      .from("avatars")
      .upload(avatarPath, pixel, { contentType: "image/png", upsert: true });
    if (error) throw new Error(error.message);
  });

  await mustFail("un tercero no puede leer el bucket privado de verificación", async () => {
    const { data, error } = await outsider.client.storage
      .from("verification")
      .download(`${worker.userId}/documento.jpg`);
    if (error) throw new Error(error.message);
    if (!data) throw new Error("sin contenido");
  });

  section("Cierre de sesión");

  await check("cerrar sesión invalida el acceso", async () => {
    await outsider.client.auth.signOut();
    const { data } = await outsider.client.auth.getClaims();
    expect(!data?.claims, "la sesión sigue activa tras cerrar sesión");
    return "sesión terminada";
  });

  for (const session of [client, worker, adminUser]) {
    await session.client.auth.signOut();
  }
}

/* ---------------------------------------------------------------- informe */

main()
  .catch((error) => {
    console.error(`\n✗ La verificación se interrumpió: ${error instanceof Error ? error.message : error}`);
    results.push({
      id: "XX",
      name: "ejecución completa",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Total: ${results.length} comprobaciones · ${results.length - failed.length} correctas · ${failed.length} fallidas`);

    if (failed.length > 0) {
      console.log("\nFallidas:");
      for (const f of failed) console.log(`  ${f.id} ${f.name} — ${f.detail}`);
      console.log("");
      process.exit(1);
    }

    console.log("\n✓ El recorrido completo funciona contra Supabase real\n");
    process.exit(0);
  });
