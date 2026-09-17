import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/verified-user";

/**
 * Piezas comunes a los repositorios de Supabase.
 *
 * Las listas de columnas se declaran una vez: si mañana cambia una, se corrige
 * aquí y no en seis consultas distintas.
 */

export type Client = Awaited<ReturnType<typeof createClient>>;

export const getClient = (): Promise<Client> => createClient();

export const JOB_COLUMNS =
  "id,reference,client_id,category_id,status,title,description,instructions,country_code," +
  "region_code,commune_code,place_name,approx_lat,approx_lng,timezone,starts_at," +
  "estimated_duration_minutes,urgency,objective_type,objective_target_position," +
  "objective_description,bonus_amount,bonus_conditions,hourly_rate,currency,offer_count," +
  "view_count,published_at,expires_at,created_at,updated_at,suggested_hourly_min," +
  "suggested_hourly_max";

export const PROFILE_COLUMNS =
  "id,first_name,last_name_initial,avatar_url,bio,city,region_code,roles,created_at";

export const WORKER_COLUMNS =
  "user_id,headline,verification_status,level,trust_index,base_hourly_rate,availability_note," +
  "accepts_overnight,is_accepting_jobs,identity_verified,phone_verified,bank_account_verified," +
  "email_verified,average_rating,review_count,completed_jobs,worked_minutes,punctuality_rate," +
  "completion_rate,cancellation_count,communication_rate,response_minutes_median";

export const ASSIGNMENT_COLUMNS =
  "id,job_id,offer_id,worker_id,client_id,status,agreed_hourly_rate,agreed_duration_minutes," +
  "agreed_total,bonus_amount,bonus_awarded,started_at,checked_in_at,handoff_completed_at," +
  "completed_at,dispute_deadline_at,created_at";

export const PAYMENT_COLUMNS =
  "id,job_id,assignment_id,extension_id,client_id,purpose,status,amount,provider," +
  "provider_transaction_id,authorized_at,paid_at,created_at";

/** Identificador del usuario de la sesión, tomado de un token con firma verificada. */
export async function currentUserId(supabase: Client): Promise<string | null> {
  const user = await getVerifiedUser(supabase);
  return user?.id ?? null;
}
