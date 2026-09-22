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
  "completed_at,dispute_deadline_at,created_at,on_the_way_at,expected_end_at," +
  "extension_minutes,completion_requested_at,completion_note";

// Sin `*`: desde el Bloque 3 las columnas de coordenadas de `job_evidence` no
// son legibles para nadie con sesión, y `select("*")` las pide igual y falla
// entero. La lista explícita es además lo que evita traer datos que la pantalla
// no usa.
export const EVIDENCE_COLUMNS =
  "id,job_id,assignment_id,author_id,author_name,evidence_type,title,body,storage_path," +
  "image_url,queue_ahead,occurred_at,created_at,event_key,visibility,mime_type,size_bytes";

export const CHECK_IN_COLUMNS =
  "id,assignment_id,job_id,worker_id,result,review_status,review_reason,distance_m," +
  "source,occurred_at,created_at";

export const EXTENSION_COLUMNS =
  "id,assignment_id,requested_by,status,additional_minutes,hourly_rate,additional_amount," +
  "reason,payment_id,responded_at,expires_at,created_at";

export const DISPUTE_COLUMNS =
  "id,assignment_id,opened_by,status,reason,description,resolution,resolution_notes," +
  "refund_amount,resolved_by,resolved_at,created_at";

export const PAYOUT_COLUMNS =
  "id,assignment_id,worker_id,status,gross_amount,commission_amount,discount_amount," +
  "bonus_amount,tax_withheld_amount,net_amount,bank_reference,notes,approved_at,paid_at," +
  "held_reason,created_at";

export const PAYMENT_COLUMNS =
  "id,job_id,assignment_id,extension_id,client_id,purpose,status,amount,provider," +
  "provider_transaction_id,authorized_at,paid_at,created_at";

/** Identificador del usuario de la sesión, tomado de un token con firma verificada. */
export async function currentUserId(supabase: Client): Promise<string | null> {
  const user = await getVerifiedUser(supabase);
  return user?.id ?? null;
}
