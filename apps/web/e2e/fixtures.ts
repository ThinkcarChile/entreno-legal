import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Datos y utilidades compartidas por las pruebas de extremo a extremo.
 *
 * Las cuentas NO están en el repositorio: salen de variables de entorno. Si
 * faltan, las pruebas que las necesitan se omiten con un motivo explícito.
 */

export interface E2EAccount {
  email: string;
  password: string;
}

function readAccount(emailVar: string, passwordVar: string): E2EAccount | null {
  const email = process.env[emailVar];
  const password = process.env[passwordVar];
  if (!email || !password) return null;
  return { email, password };
}

export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const publishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "";
export const secretKey =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export const clientAccount = readAccount("E2E_CLIENT_EMAIL", "E2E_CLIENT_PASSWORD");
export const workerAccount = readAccount("E2E_WORKER_EMAIL", "E2E_WORKER_PASSWORD");
export const adminAccount = readAccount("E2E_ADMIN_EMAIL", "E2E_ADMIN_PASSWORD");

/** ¿Están dadas las condiciones para correr el recorrido completo? */
export function supabaseReady(): string | null {
  if (!supabaseUrl || !publishableKey) {
    return "faltan NEXT_PUBLIC_SUPABASE_URL y la clave pública";
  }
  if (!secretKey) return "falta SUPABASE_SECRET_KEY para preparar las cuentas";
  if (!clientAccount) return "faltan E2E_CLIENT_EMAIL y E2E_CLIENT_PASSWORD";
  if (!workerAccount) return "faltan E2E_WORKER_EMAIL y E2E_WORKER_PASSWORD";
  if (!adminAccount) return "faltan E2E_ADMIN_EMAIL y E2E_ADMIN_PASSWORD";
  return null;
}

export function adminClient(): SupabaseClient {
  return createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Deja las cuentas listas: creadas, confirmadas, con onboarding hecho y, en el
 * caso del trabajador, verificadas.
 *
 * Se hace por API y no por la interfaz a propósito: el registro con confirmación
 * de correo no se puede automatizar sin un buzón, y lo que estas pruebas deben
 * cubrir es el marketplace, no el envío de correos.
 */
export async function ensureFixtures(): Promise<{
  clientId: string;
  workerId: string;
  adminId: string;
}> {
  const admin = adminClient();

  async function ensureUser(acc: E2EAccount): Promise<string> {
    const created = await admin.auth.admin.createUser({
      email: acc.email,
      password: acc.password,
      email_confirm: true,
    });

    if (created.data.user) return created.data.user.id;

    // Ya existía: se busca por correo.
    const list = await admin.auth.admin.listUsers({ perPage: 1000 });
    const found = list.data.users.find((u) => u.email === acc.email);
    if (!found) throw new Error(`no se pudo preparar la cuenta ${acc.email}`);

    // Asegura la contraseña conocida por si la cuenta venía de otra ejecución.
    await admin.auth.admin.updateUserById(found.id, {
      password: acc.password,
      email_confirm: true,
    });
    return found.id;
  }

  const clientId = await ensureUser(clientAccount!);
  const workerId = await ensureUser(workerAccount!);
  const adminId = await ensureUser(adminAccount!);

  await admin
    .from("profiles")
    .update({
      first_name: "Paula",
      last_name_initial: "C",
      region_code: "13",
      commune_code: "13-providencia",
      city: "Providencia",
      roles: ["CLIENT"],
      onboarding_completed_at: new Date().toISOString(),
    })
    .eq("id", clientId);

  await admin
    .from("profiles")
    .update({
      first_name: "Andrés",
      last_name_initial: "C",
      region_code: "13",
      commune_code: "13-santiago",
      city: "Santiago",
      roles: ["WORKER"],
      onboarding_completed_at: new Date().toISOString(),
    })
    .eq("id", workerId);

  await admin.from("profiles").update({ role: "ADMIN" }).eq("id", adminId);

  await admin.from("worker_profiles").upsert(
    {
      user_id: workerId,
      headline: "Filas y trámites en Santiago",
      base_hourly_rate: 10000,
      availability_note: "Lunes a domingo",
      verification_status: "VERIFIED",
      identity_verified: true,
      phone_verified: true,
      is_accepting_jobs: true,
      level: "VERIFICADO",
    },
    { onConflict: "user_id" },
  );

  await admin.from("worker_service_areas").upsert(
    { worker_id: workerId, region_code: "13", commune_code: "13-providencia", radius_km: 15 },
    { onConflict: "worker_id,region_code,commune_code" },
  );

  return { clientId, workerId, adminId };
}

/** Marca única para no confundir los datos de una ejecución con los de otra. */
export const runTag = `e2e-${Date.now()}`;
