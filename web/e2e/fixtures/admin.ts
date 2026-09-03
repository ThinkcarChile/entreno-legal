/**
 * ADMINISTRACIÓN DE STAGING PARA LOS E2E: preparar y limpiar.
 *
 * Es el ÚNICO archivo que toca la llave service_role, y la usa exclusivamente
 * desde el proceso de Playwright (Node), nunca desde el navegador. Un spec que
 * necesite un estado de partida lo pide acá; un spec que importe supabase-js
 * con service_role por su cuenta está mal y hay que arreglarlo, no copiarlo.
 *
 * Todo lo que se hace acá es sobre el hogar SINTÉTICO de A y B (o el de AJENO).
 * No existe ningún camino desde este archivo hacia la base de la familia: la
 * URL y la llave salen de E2E_SUPABASE_*, que sólo apuntan a staging.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ENV, credenciales, type Usuario } from "./contrato";

let cliente: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  if (cliente) return cliente;
  const url = process.env[ENV.supabaseUrl];
  const key = process.env[ENV.serviceRoleKey];
  if (!url || !key) throw new Error("Faltan E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_ROLE_KEY.");
  // Guarda contra el error más caro: apuntar el limpiador a producción.
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL === url) {
    throw new Error("E2E_SUPABASE_URL es el mismo proyecto que NEXT_PUBLIC_SUPABASE_URL: eso es producción. Me niego.");
  }
  cliente = createClient(url, key, { auth: { persistSession: false } });
  return cliente;
}

/** El id de auth de un usuario sintético, por su correo. */
export async function idDeUsuario(u: Usuario): Promise<string> {
  const { email } = credenciales(u);
  const { data, error } = await admin().auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const encontrado = data.users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
  if (!encontrado) throw new Error(`El usuario ${u} (${email}) no existe en staging. Corre el bootstrap.`);
  return encontrado.id;
}

/** El hogar al que pertenece un usuario sintético. */
export async function hogarDe(u: Usuario): Promise<string> {
  const uid = await idDeUsuario(u);
  const { data, error } = await admin()
    .from("household_members")
    .select("household_id")
    .eq("user_id", uid)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`El usuario ${u} no pertenece a ningún hogar en staging.`);
  return data.household_id as string;
}

/**
 * Deja el hogar de A/B sin planes, listas, lotes ni eventos, conservando el
 * hogar, sus integrantes y sus perfiles. Cada flujo parte de una cocina vacía.
 *
 * El orden importa por las FK y por los guardianes append-only: se borra de
 * abajo hacia arriba, y lo que es historia (movimientos, auditoría) se deja —
 * un E2E que necesite historia vacía debe crear un hogar nuevo, no borrar la
 * de otro.
 */
export async function vaciarCocina(u: Usuario = "A"): Promise<void> {
  const db = admin();
  const hogar = await hogarDe(u);
  const borrar = async (tabla: string, columna = "household_id") => {
    const { error } = await db.from(tabla).delete().eq(columna, hogar);
    if (error) throw new Error(`${tabla}: ${error.message}`);
  };
  await borrar("nutrition_events");
  await borrar("shopping_lists");
  await borrar("weekly_plans");
  await borrar("inventory_lots");
}
